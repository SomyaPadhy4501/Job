//! Roles, decided in one place. Deny by default: a signed-in account is a
//! `User`; it is the `Owner` only when its Google `sub` is listed in
//! `OWNER_SUBS`. Extension tokens never carry a role beyond their own user's
//! autofill data, and nothing grants `Owner` but that list.
//!
//! An owner-only handler takes [`Owner`] as an argument instead of checking
//! by hand, so forgetting the check isn't possible: anyone else gets 404 (the
//! route doesn't reveal it exists), and a signed-out caller 401.

use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use serde::Serialize;

use crate::auth::Signed;
use crate::error::ApiError;
use crate::{AppState, Config};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    User,
    Owner,
}

impl Role {
    pub fn of(config: &Config, user: &db::User) -> Role {
        let listed =
            !user.google_sub.is_empty() && config.owner_subs.iter().any(|s| s == &user.google_sub);
        if listed { Role::Owner } else { Role::User }
    }
}

/// A signed-in owner. Extract it to make a handler owner-only.
pub struct Owner(pub Signed);

impl FromRequestParts<AppState> for Owner {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let signed = Signed::from_request_parts(parts, state).await?;
        match Role::of(&state.config, &signed.user) {
            Role::Owner => Ok(Owner(signed)),
            Role::User => Err(ApiError::NotFound),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user(sub: &str) -> db::User {
        let now = time::OffsetDateTime::now_utc();
        db::User {
            id: uuid::Uuid::new_v4(),
            google_sub: sub.into(),
            email: "a@example.com".into(),
            email_verified: true,
            name: String::new(),
            avatar_url: String::new(),
            created_at: now,
            last_login_at: now,
            disabled_at: None,
        }
    }

    #[test]
    fn only_listed_subs_are_owners() {
        let config = Config {
            owner_subs: vec!["111".into()],
            ..Config::default()
        };
        assert_eq!(Role::of(&config, &user("111")), Role::Owner);
        assert_eq!(Role::of(&config, &user("222")), Role::User);
        assert_eq!(Role::of(&config, &user("")), Role::User);
        assert_eq!(Role::of(&Config::default(), &user("111")), Role::User);
    }
}
