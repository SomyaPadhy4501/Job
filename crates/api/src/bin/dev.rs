//! Local dev server for the `/api` Router: `cargo run -p api --bin dev`
//! (or `docker compose up api`). The Vite dev server proxies `/api` here
//! (web/vite.config.js).
//!
//! Unlike the Vercel function, this binary turns on
//! `POST /api/auth/dev-login`, so the web app can be tried without a Google
//! client id. Set `DEV_LOGIN=0` to turn it off. It is refused whenever
//! `VERCEL` is set.

#[tokio::main]
async fn main() {
    let addr = std::env::var("API_ADDR").unwrap_or_else(|_| "127.0.0.1:4100".to_owned());
    let mut config = api::Config::from_env();
    config.dev_login =
        std::env::var_os("VERCEL").is_none() && std::env::var("DEV_LOGIN").as_deref() != Ok("0");
    // Locally, anyone may sign up unless told otherwise.
    if std::env::var_os("SIGNUPS_OPEN").is_none() {
        config.signups_open = true;
    }
    let app = api::router(api::AppState::from_env_with(config));
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .unwrap_or_else(|err| panic!("cannot bind {addr}: {err}"));
    eprintln!("api dev server listening on http://{addr}");
    axum::serve(listener, app).await.expect("server error");
}
