//! `POST /api/capture/jobs`: job listings shared by signed-in users'
//! extensions (opt-in, "Share job listings I browse"), so careers sites the
//! collector can't reach (Tesla, …) still reach the board.
//!
//! Users never hold the owner's collect token. This route checks the user's
//! extension token, keeps only listing fields, accepts a listing only when its
//! link is on the site it was captured from (or on a known ATS), caps each
//! user per day, and forwards the rest to the Node backend's `/admin/ingest`
//! with the collect token, server to server. The usual normalize filters
//! (US, software, level) then run on everything, as for any other source.
//!
//! The owner's own Workday collection (extension/workday-collect.js) comes
//! here too, so no extension ever holds the collect token: rows from a
//! Workday page must link to Workday, are stored as source `workday` (the
//! same rows the server collector made) and have their own daily count. An
//! owner (`OWNER_SUBS`) isn't counted at all.

use axum::Json;
use axum::extract::State;
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::AppState;
use crate::autofill::TokenUser;
use crate::error::{ApiError, ApiResult};
use crate::http::{JsonBody, today};
use crate::roles::Role;

/// Listings one request may share (the extension sends at most this many).
pub const MAX_PER_REQUEST: usize = 200;
/// What the board stores from a shared listing; anything else is dropped.
const FIELDS: &[(&str, usize)] = &[
    ("external_id", 300),
    ("company_name", 200),
    ("job_title", 300),
    ("location", 300),
    ("apply_url", 2000),
    ("date_posted", 64),
    ("description", 30_000),
];
/// Hosts whose own listings are never taken from users' browsing: their
/// terms forbid it, and their links point back to themselves.
const REFUSED_SITES: &[&str] = &["linkedin.com", "indeed.com", "glassdoor.com"];
/// Application hosts that careers sites link to from their own pages.
const ATS_HOSTS: &[&str] = &[
    "greenhouse.io",
    "lever.co",
    "ashbyhq.com",
    "myworkdayjobs.com",
    "myworkdaysite.com",
    "smartrecruiters.com",
    "icims.com",
    "jobvite.com",
    "taleo.net",
    "oraclecloud.com",
    "successfactors.com",
    "successfactors.eu",
    "eightfold.ai",
    "phenompeople.com",
    "workable.com",
    "bamboohr.com",
    "rippling.com",
    "recruitee.com",
    "breezy.hr",
    "jazzhr.com",
    "applytojob.com",
];

/// `www.tesla.com` → `tesla.com`. Good enough to tell a company's own careers
/// subdomains apart from other sites (two-label suffixes like `co.uk` keep
/// three labels).
fn site(host: &str) -> String {
    let labels: Vec<&str> = host.trim_end_matches('.').split('.').collect();
    let keep = if labels.len() >= 3
        && labels[labels.len() - 2].len() <= 3
        && labels[labels.len() - 1].len() == 2
    {
        3
    } else {
        2
    };
    labels[labels.len().saturating_sub(keep)..]
        .join(".")
        .to_ascii_lowercase()
}

fn on(host: &str, domain: &str) -> bool {
    host == domain || host.ends_with(&format!(".{domain}"))
}

/// Workday's job sites, where the Workday collection reads.
fn workday_host(host: &str) -> bool {
    on(host, "myworkdayjobs.com") || on(host, "myworkdaysite.com")
}

fn https_host(raw: &str) -> Option<String> {
    let rest = raw.strip_prefix("https://")?;
    let authority = rest.split(['/', '?', '#']).next()?;
    if authority.contains('@') || authority.is_empty() {
        return None;
    }
    let host = authority.split(':').next()?.to_ascii_lowercase();
    host.contains('.').then_some(host)
}

/// The cleaned listing, or why it was refused.
pub fn clean_listing(page_host: &str, raw: &Value) -> Result<Map<String, Value>, &'static str> {
    let obj = raw.as_object().ok_or("not an object")?;
    let mut out = Map::new();
    for (key, max) in FIELDS {
        if let Some(Value::String(s)) = obj.get(*key) {
            let s = accounts::truncate_chars(s.trim(), *max).to_owned();
            if !s.is_empty() {
                out.insert((*key).to_owned(), Value::String(s));
            }
        }
    }
    for required in ["job_title", "apply_url"] {
        if !out.contains_key(required) {
            return Err("missing title or link");
        }
    }
    let link = out["apply_url"].as_str().unwrap_or_default();
    let link_host = https_host(link).ok_or("link isn't https")?;
    let same_site = site(&link_host) == site(page_host);
    let ats = ATS_HOSTS.iter().any(|d| on(&link_host, d));
    if !same_site && !ats {
        return Err("link is on another site");
    }
    // Shared rows are keyed by the page's host, like the owner's capture.
    if !out.contains_key("external_id") {
        out.insert(
            "external_id".into(),
            Value::String(format!("{page_host}:{link}")),
        );
    }
    Ok(out)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareBody {
    page_url: String,
    jobs: Vec<Value>,
}

pub async fn share(
    State(state): State<AppState>,
    who: TokenUser,
    JsonBody(body): JsonBody<ShareBody>,
) -> ApiResult<Json<Value>> {
    let c = &state.config;
    if !c.sharing_open {
        return Err(ApiError::Forbidden(
            "Sharing listings is turned off on this board.".into(),
        ));
    }
    let (Some(ingest), Some(collect_token)) = (c.ingest_url.as_deref(), c.collect_token.as_deref())
    else {
        return Err(ApiError::Unavailable(
            "Sharing listings isn't set up on this server.".into(),
        ));
    };
    if body.jobs.len() > MAX_PER_REQUEST {
        return Err(ApiError::bad(format!(
            "Share at most {MAX_PER_REQUEST} listings at a time."
        )));
    }
    let page_host = https_host(&body.page_url)
        .ok_or_else(|| ApiError::bad("The page must be an https:// careers page."))?;
    if REFUSED_SITES.iter().any(|d| on(&page_host, d)) {
        return Err(ApiError::Forbidden(
            "Listings from this site aren't taken from browsing.".into(),
        ));
    }

    let workday = workday_host(&page_host);
    let mut accepted = Vec::new();
    let mut refused = 0usize;
    for raw in &body.jobs {
        match clean_listing(&page_host, raw) {
            // A Workday page's rows are stored as Workday's: only Workday links.
            Ok(row)
                if !workday
                    || https_host(row["apply_url"].as_str().unwrap_or_default())
                        .is_some_and(|h| workday_host(&h)) =>
            {
                accepted.push(Value::Object(row))
            }
            _ => refused += 1,
        }
    }
    if accepted.is_empty() {
        return Ok(Json(
            json!({ "received": body.jobs.len(), "sent": 0, "refused": refused }),
        ));
    }

    let user_id = who.user.id;
    if Role::of(c, &who.user) != Role::Owner {
        let (bucket, cap) = if workday {
            ("share_workday", c.workday_shares_per_day)
        } else {
            ("share", c.shares_per_day)
        };
        let used = db::bump_counter(
            state.pool()?,
            &format!("user:{user_id}"),
            bucket,
            &today(),
            accepted.len() as i64,
        )
        .await?;
        if used > cap {
            return Err(ApiError::TooMany(format!(
                "You've shared {cap} listings today, the most for one day. Thanks! Try again tomorrow."
            )));
        }
    }

    let res = state
        .http
        .post(ingest)
        .header("x-collect-token", collect_token)
        .json(&json!({ "source": if workday { "workday" } else { "extension" }, "jobs": accepted }))
        .send()
        .await
        .map_err(|e| {
            eprintln!("share: ingest unreachable: {e}");
            ApiError::Unavailable("The job board couldn't take listings right now.".into())
        })?;
    let status = res.status();
    let result: Value = res.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        eprintln!("share: ingest answered {status}");
        return Err(ApiError::Unavailable(
            "The job board couldn't take listings right now.".into(),
        ));
    }
    db::audit(state.pool()?, Some(user_id), "listings_share").await?;
    Ok(Json(json!({
        "received": body.jobs.len(),
        "sent": accepted.len(),
        "refused": refused,
        "inserted": result["inserted"],
        "updated": result["updated"],
        "rejected": result["rejected"],
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn job(link: &str) -> Value {
        json!({ "job_title": "Software Engineer", "apply_url": link, "location": "Palo Alto, CA", "salary": "ignored" })
    }

    #[test]
    fn sites() {
        assert_eq!(site("www.tesla.com"), "tesla.com");
        assert_eq!(site("careers.bbc.co.uk"), "bbc.co.uk");
        assert_eq!(
            https_host("https://www.tesla.com/careers/1?x"),
            Some("www.tesla.com".into())
        );
        assert_eq!(https_host("http://www.tesla.com/x"), None);
        assert_eq!(https_host("https://user@evil.example/x"), None);
    }

    #[test]
    fn links_must_stay_on_the_page_site_or_a_known_ats() {
        let row = clean_listing(
            "www.tesla.com",
            &job("https://www.tesla.com/careers/search/job/1"),
        )
        .unwrap();
        assert!(row.get("salary").is_none(), "only listing fields are kept");
        assert!(
            row["external_id"]
                .as_str()
                .unwrap()
                .starts_with("www.tesla.com:")
        );
        assert!(clean_listing("careers.acme.com", &job("https://jobs.acme.com/1")).is_ok());
        assert!(
            clean_listing(
                "careers.acme.com",
                &job("https://boards.greenhouse.io/acme/jobs/1")
            )
            .is_ok()
        );
        assert!(clean_listing("www.tesla.com", &job("https://evil.example/phish")).is_err());
        assert!(clean_listing("www.tesla.com", &job("http://www.tesla.com/1")).is_err());
        assert!(clean_listing("www.tesla.com", &json!({ "job_title": "x" })).is_err());
        assert!(clean_listing("www.tesla.com", &json!("text")).is_err());
    }

    #[test]
    fn long_fields_are_cut() {
        let mut j = job("https://www.tesla.com/1");
        j["description"] = json!("x".repeat(40_000));
        let row = clean_listing("www.tesla.com", &j).unwrap();
        assert_eq!(row["description"].as_str().unwrap().len(), 30_000);
    }
}
