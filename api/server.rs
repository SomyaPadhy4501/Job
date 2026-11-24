//! Vercel Rust function. vercel.json rewrites every `/api/*` request here; the
//! Router keeps the original path, so its routes are written as `/api/...`.

use tower::ServiceBuilder;
use vercel_runtime::{Error, axum::VercelLayer};

#[tokio::main]
async fn main() -> Result<(), Error> {
    let app = ServiceBuilder::new()
        .layer(VercelLayer::new())
        .service(api::router(api::AppState::from_env()));
    vercel_runtime::run(app).await
}
