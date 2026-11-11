//! Server-sent events (src/changes.js). Whatever writes rings the bell; the
//! rings inside one short window go out as one `data: changed`. A named event
//! (an approval) goes at once with its payload; a ping every 20 s tells a page
//! whose connection slept that it is still alive.

use crate::serve::Shared;
use axum::{body::Body, extract::State, http::header, response::{IntoResponse, Response}, routing::get, Router};
use std::{sync::{atomic::{AtomicBool, Ordering}, Arc}, time::Duration};
use tokio::sync::broadcast;
use tokio_stream::{wrappers::{BroadcastStream, IntervalStream}, StreamExt};

pub struct Bell { tx: broadcast::Sender<String>, pending: Arc<AtomicBool>, rt: tokio::runtime::Handle }

fn ms(var: &str, default: u64) -> Duration {
    Duration::from_millis(std::env::var(var).ok().and_then(|v| v.parse().ok()).unwrap_or(default))
}

impl Bell {
    /// made inside the server's runtime; rings from the watcher's thread go through it
    pub fn new() -> Self { Bell { tx: broadcast::channel(256).0, pending: Arc::new(AtomicBool::new(false)), rt: tokio::runtime::Handle::current() } }

    /// changed(): one notice per PILO_CHANGE_WINDOW_MS, however many writes
    pub fn changed(&self) {
        if self.pending.swap(true, Ordering::SeqCst) { return; }
        let (tx, pending) = (self.tx.clone(), self.pending.clone());
        self.rt.spawn(async move {
            tokio::time::sleep(ms("PILO_CHANGE_WINDOW_MS", 150)).await;
            pending.store(false, Ordering::SeqCst);
            let _ = tx.send("data: changed\n\n".into());
        });
    }

    /// broadcast(name, payload): at once, to every stream
    #[allow(dead_code)]
    pub fn named(&self, name: &str, payload: &serde_json::Value) {
        let _ = self.tx.send(format!("event: {name}\ndata: {payload}\n\n"));
    }

    pub fn listening(&self) -> usize { self.tx.receiver_count() }
}

async fn open(State(app): State<Shared>) -> Response {
    let ping = ms("PILO_STREAM_PING_MS", 20000);
    let first = tokio_stream::once("retry: 3000\n\n".to_string());
    let rings = BroadcastStream::new(app.bell.tx.subscribe()).filter_map(Result::ok);
    let mut every = tokio::time::interval_at(tokio::time::Instant::now() + ping, ping);
    every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let pings = IntervalStream::new(every).map(|_| "event: ping\ndata: .\n\n".to_string());
    let body = first.chain(rings.merge(pings)).map(|s| Ok::<_, std::convert::Infallible>(axum::body::Bytes::from(s)));
    (
        [(header::CONTENT_TYPE, "text/event-stream; charset=utf-8"), (header::CACHE_CONTROL, "no-store, no-transform"),
         (header::CONNECTION, "keep-alive"), (header::HeaderName::from_static("x-accel-buffering"), "no")],
        Body::from_stream(body),
    ).into_response()
}

pub fn routes(r: Router<Shared>) -> Router<Shared> { r.route("/api/stream", get(open)) }
