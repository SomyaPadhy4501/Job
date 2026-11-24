//! `GET /api/autofill/form-schema?url=<application page>`: the question list
//! an ATS publishes for a posting, so the extension knows each field's label
//! and whether it's required even when the page's markup doesn't say.
//!
//! Only two fixed public APIs are ever fetched (Greenhouse's board API and
//! Ashby's posting API); the page URL only supplies validated path segments,
//! so a caller can't point the server anywhere else. Results are public data
//! and are cached per instance for an hour.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use axum::Json;
use axum::extract::{Query, State};
use reqwest::Url;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::AppState;
use crate::autofill::TokenUser;
use crate::error::{ApiError, ApiResult};

const TTL: Duration = Duration::from_secs(3600);
const MAX_CACHED: usize = 500;
const MAX_FIELDS: usize = 200;

#[derive(Debug, PartialEq, Eq)]
pub enum Target {
    Greenhouse { board: String, job: String },
    Ashby { org: String, posting: String },
}

impl Target {
    fn key(&self) -> String {
        match self {
            Target::Greenhouse { board, job } => format!("gh:{board}:{job}"),
            Target::Ashby { org, posting } => format!("ashby:{org}:{posting}"),
        }
    }
}

fn slug(s: &str) -> Option<String> {
    let ok = !s.is_empty()
        && s.len() <= 100
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        && s != "."
        && s != "..";
    ok.then(|| s.to_owned())
}

fn digits(s: &str) -> Option<String> {
    (!s.is_empty() && s.len() <= 20 && s.bytes().all(|b| b.is_ascii_digit())).then(|| s.to_owned())
}

fn uuid_like(s: &str) -> Option<String> {
    (s.len() == 36 && s.chars().all(|c| c.is_ascii_hexdigit() || c == '-'))
        .then(|| s.to_ascii_lowercase())
}

/// Which posting an application page belongs to, if it's one we can look up.
pub fn parse_target(page: &str) -> Option<Target> {
    let url = Url::parse(page).ok()?;
    if url.scheme() != "https" {
        return None;
    }
    let host = url.host_str()?;
    let parts: Vec<&str> = url.path_segments()?.filter(|s| !s.is_empty()).collect();
    match host {
        "job-boards.greenhouse.io" | "boards.greenhouse.io" => {
            if parts.first() == Some(&"embed") {
                let q: HashMap<_, _> = url.query_pairs().collect();
                return Some(Target::Greenhouse {
                    board: slug(q.get("for")?)?,
                    job: digits(q.get("token")?)?,
                });
            }
            match parts.as_slice() {
                [board, "jobs", job, ..] => Some(Target::Greenhouse {
                    board: slug(board)?,
                    job: digits(job)?,
                }),
                _ => None,
            }
        }
        "jobs.ashbyhq.com" => match parts.as_slice() {
            [org, posting, ..] => Some(Target::Ashby {
                org: slug(org)?,
                posting: uuid_like(posting)?,
            }),
            _ => None,
        },
        _ => None,
    }
}

fn field(name: &str, label: &str, required: bool) -> Value {
    json!({ "name": name, "label": label, "required": required })
}

/// Greenhouse `GET /v1/boards/{board}/jobs/{id}?questions=true`.
pub fn greenhouse_fields(body: &Value) -> Vec<Value> {
    let mut out = Vec::new();
    for group in ["questions", "location_questions"] {
        for q in body[group].as_array().into_iter().flatten() {
            let label = q["label"].as_str().unwrap_or("").trim();
            let required = q["required"].as_bool().unwrap_or(false);
            for f in q["fields"].as_array().into_iter().flatten() {
                let (Some(name), kind) = (f["name"].as_str(), f["type"].as_str().unwrap_or(""))
                else {
                    continue;
                };
                if kind == "input_hidden" || label.is_empty() {
                    continue;
                }
                out.push(field(name, label, required));
            }
        }
    }
    out.truncate(MAX_FIELDS);
    out
}

/// Ashby `ApiJobPosting`: `applicationForm.sections[].fieldEntries[]`.
pub fn ashby_fields(body: &Value) -> Vec<Value> {
    let mut out = Vec::new();
    let sections = &body["data"]["jobPosting"]["applicationForm"]["sections"];
    for s in sections.as_array().into_iter().flatten() {
        for e in s["fieldEntries"].as_array().into_iter().flatten() {
            let f = &e["field"];
            let (Some(path), Some(title)) = (f["path"].as_str(), f["title"].as_str()) else {
                continue;
            };
            if title.trim().is_empty() || f["isDeactivated"].as_bool() == Some(true) {
                continue;
            }
            out.push(field(
                path,
                title.trim(),
                e["isRequired"].as_bool().unwrap_or(false),
            ));
        }
    }
    out.truncate(MAX_FIELDS);
    out
}

const ASHBY_QUERY: &str = "query ApiJobPosting($organizationHostedJobsPageName: String!, $jobPostingId: String!) { jobPosting(organizationHostedJobsPageName: $organizationHostedJobsPageName, jobPostingId: $jobPostingId) { id applicationForm { sections { fieldEntries { ... on FormFieldEntry { id field isRequired } } } } } }";

async fn fetch(state: &AppState, target: &Target) -> Result<Vec<Value>, ApiError> {
    let unavailable = || ApiError::Unavailable("The application form couldn't be read.".into());
    let res =
        match target {
            Target::Greenhouse { board, job } => state
                .http
                .get(format!(
                    "https://boards-api.greenhouse.io/v1/boards/{board}/jobs/{job}?questions=true"
                ))
                .send()
                .await,
            Target::Ashby { org, posting } => state
                .http
                .post("https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobPosting")
                .json(&json!({
                    "operationName": "ApiJobPosting",
                    "variables": { "organizationHostedJobsPageName": org, "jobPostingId": posting },
                    "query": ASHBY_QUERY,
                }))
                .send()
                .await,
        }
        .map_err(|_| unavailable())?;
    if res.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(ApiError::NotFound);
    }
    if !res.status().is_success() {
        return Err(unavailable());
    }
    let body: Value = res.json().await.map_err(|_| unavailable())?;
    Ok(match target {
        Target::Greenhouse { .. } => greenhouse_fields(&body),
        Target::Ashby { .. } => ashby_fields(&body),
    })
}

type Cache = Mutex<HashMap<String, (Instant, Vec<Value>)>>;
fn cache() -> &'static Cache {
    static CACHE: OnceLock<Cache> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

#[derive(Deserialize)]
pub struct SchemaQuery {
    url: String,
}

pub async fn form_schema(
    State(state): State<AppState>,
    _who: TokenUser,
    Query(q): Query<SchemaQuery>,
) -> ApiResult<Json<Value>> {
    let Some(target) = parse_target(&q.url) else {
        // Not an error: most pages simply have no public schema.
        return Ok(Json(json!({ "fields": [] })));
    };
    let key = target.key();
    if let Some((_, fields)) = cache()
        .lock()
        .ok()
        .and_then(|c| c.get(&key).cloned())
        .filter(|(at, _)| at.elapsed() < TTL)
    {
        return Ok(Json(json!({ "fields": fields })));
    }
    let fields = fetch(&state, &target).await?;
    if let Ok(mut c) = cache().lock() {
        if c.len() >= MAX_CACHED {
            c.retain(|_, (at, _)| at.elapsed() < TTL);
            if c.len() >= MAX_CACHED {
                c.clear();
            }
        }
        c.insert(key, (Instant::now(), fields.clone()));
    }
    Ok(Json(json!({ "fields": fields })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_only_known_application_pages() {
        assert_eq!(
            parse_target("https://job-boards.greenhouse.io/figma/jobs/6233043004?gh_src=x"),
            Some(Target::Greenhouse {
                board: "figma".into(),
                job: "6233043004".into()
            })
        );
        assert_eq!(
            parse_target("https://job-boards.greenhouse.io/embed/job_app?for=stripe&token=7210000"),
            Some(Target::Greenhouse {
                board: "stripe".into(),
                job: "7210000".into()
            })
        );
        assert_eq!(
            parse_target(
                "https://jobs.ashbyhq.com/openai/3C67F712-697d-48d8-b05c-01be896e61da/application"
            ),
            Some(Target::Ashby {
                org: "openai".into(),
                posting: "3c67f712-697d-48d8-b05c-01be896e61da".into()
            })
        );
        for bad in [
            "http://job-boards.greenhouse.io/figma/jobs/1",
            "https://evil.example/figma/jobs/1",
            "https://job-boards.greenhouse.io/fig%2Fma/jobs/1",
            "https://job-boards.greenhouse.io/figma/jobs/12a",
            "https://jobs.ashbyhq.com/openai/not-a-uuid",
            "https://jobs.lever.co/palantir/ab7e3425-81d5-4705-a7b5-cd60c8a45cdb/apply",
            "not a url",
        ] {
            assert_eq!(parse_target(bad), None, "{bad}");
        }
    }

    #[test]
    fn maps_greenhouse_questions() {
        let body = json!({
            "questions": [
                { "label": "First Name", "required": true, "fields": [{ "name": "first_name", "type": "input_text" }] },
                { "label": "Resume/CV", "required": false, "fields": [
                    { "name": "resume", "type": "input_file" }, { "name": "resume_text", "type": "textarea" }
                ] }
            ],
            "location_questions": [
                { "label": "Latitude", "required": true, "fields": [{ "name": "latitude", "type": "input_hidden" }] },
                { "label": "Location", "required": true, "fields": [{ "name": "location", "type": "input_text" }] }
            ]
        });
        assert_eq!(
            greenhouse_fields(&body),
            vec![
                field("first_name", "First Name", true),
                field("resume", "Resume/CV", false),
                field("resume_text", "Resume/CV", false),
                field("location", "Location", true),
            ]
        );
    }

    #[test]
    fn maps_ashby_fields() {
        let body = json!({ "data": { "jobPosting": { "applicationForm": { "sections": [
            { "fieldEntries": [
                { "field": { "path": "_systemfield_name", "title": "Legal Name" }, "isRequired": true },
                { "field": { "path": "abc", "title": "Old question", "isDeactivated": true }, "isRequired": true },
                { "field": { "path": "def", "title": "When can you start a new role?" }, "isRequired": false }
            ] }
        ] } } } });
        assert_eq!(
            ashby_fields(&body),
            vec![
                field("_systemfield_name", "Legal Name", true),
                field("def", "When can you start a new role?", false),
            ]
        );
    }
}
