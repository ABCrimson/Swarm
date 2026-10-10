//! Upgrade admission for `/ws`: the 503 refusals, the `Authorization:
//! Bearer` fast path and the per-address handshake share. The policy is
//! described in the [`super`] module doc ("Admission").

use std::collections::HashMap;
use std::collections::hash_map::Entry;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;

use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use parking_lot::Mutex;
use tokio::sync::OwnedSemaphorePermit;

#[cfg(doc)]
use super::upgrade;
#[cfg(doc)]
use crate::Limits;

pub(super) fn refuse(peer: SocketAddr, reason: &'static str) -> Response {
    tracing::warn!(%peer, reason, "WebSocket upgrade refused");
    (StatusCode::SERVICE_UNAVAILABLE, reason).into_response()
}

/// The token from an `Authorization: Bearer <token>` header (the scheme is
/// case-insensitive).
pub(super) fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    let (scheme, token) = headers
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .split_once(' ')?;
    scheme.eq_ignore_ascii_case("bearer").then(|| token.trim())
}

/// What [`upgrade`] reserved for a connection.
pub(super) enum Admission {
    /// A valid Bearer header: the connection slot itself.
    Authenticated(OwnedSemaphorePermit),
    /// Not yet authenticated: a permit from the daemon-wide handshake pool
    /// and, for a remote peer, one from its address's share, both released
    /// once the handshake ends, successfully or not.
    Pending(OwnedSemaphorePermit, Option<PeerPermit>),
}

/// Handshakes in flight per remote client address, capped at
/// [`Limits::max_pending_handshakes_per_peer`] so one remote host cannot take
/// the whole handshake pool (see the [`super`] module doc for why loopback is
/// exempt).
pub(crate) struct PeerHandshakes {
    limit: usize,
    counts: Mutex<HashMap<IpAddr, usize>>,
}

/// The address a peer's handshakes are counted under, or `None` for a
/// loopback peer, which has no per-address share. An IPv4 client of a
/// dual-stack listener shows up v4-mapped and counts as its IPv4 address;
/// an IPv6 client counts as its `/64`, since one host usually holds the
/// whole block and could otherwise pick a fresh address per socket.
fn peer_key(ip: IpAddr) -> Option<IpAddr> {
    match ip.to_canonical() {
        ip if ip.is_loopback() => None,
        IpAddr::V6(v6) => Some(IpAddr::V6((v6.to_bits() & !u128::from(u64::MAX)).into())),
        v4 @ IpAddr::V4(_) => Some(v4),
    }
}

impl PeerHandshakes {
    pub(crate) fn new(limit: usize) -> Arc<Self> {
        Arc::new(Self {
            limit,
            counts: Mutex::default(),
        })
    }

    /// Takes one of `ip`'s handshake permits: `Ok(None)` for a loopback
    /// peer, which needs none, and `Err(ShareUsedUp)` when its share is gone.
    pub(super) fn try_acquire(
        self: &Arc<Self>,
        ip: IpAddr,
    ) -> Result<Option<PeerPermit>, ShareUsedUp> {
        let Some(ip) = peer_key(ip) else {
            return Ok(None);
        };
        let mut counts = self.counts.lock();
        let count = counts.entry(ip).or_default();
        if *count >= self.limit {
            return Err(ShareUsedUp);
        }
        *count += 1;
        Ok(Some(PeerPermit {
            peers: Arc::clone(self),
            ip,
        }))
    }
}

/// A remote address already holds its whole share of handshake permits.
#[derive(Debug)]
pub(super) struct ShareUsedUp;

/// One of a remote address's handshake permits; returned on drop.
pub(super) struct PeerPermit {
    peers: Arc<PeerHandshakes>,
    ip: IpAddr,
}

impl Drop for PeerPermit {
    fn drop(&mut self) {
        let mut counts = self.peers.counts.lock();
        if let Entry::Occupied(mut count) = counts.entry(self.ip) {
            *count.get_mut() -= 1;
            if *count.get() == 0 {
                count.remove();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use axum::http::HeaderValue;

    use super::*;

    fn ip(text: &str) -> IpAddr {
        text.parse().unwrap()
    }

    /// Each remote address gets its own share of handshake permits,
    /// v4-mapped spellings count as the IPv4 address, and dropped permits
    /// come back without leaving empty entries behind.
    #[test]
    fn test_peer_handshake_permits_are_capped_per_address() {
        let peers = PeerHandshakes::new(2);
        let a = ip("192.0.2.1");
        let first = peers.try_acquire(a).unwrap();
        let second = peers.try_acquire(a).unwrap();
        assert!(
            peers.try_acquire(a).is_err(),
            "the address's share is used up"
        );
        assert!(
            peers.try_acquire(ip("::ffff:192.0.2.1")).is_err(),
            "a v4-mapped spelling shares the IPv4 address's share"
        );
        assert!(
            peers.try_acquire(ip("192.0.2.2")).unwrap().is_some(),
            "other addresses are unaffected"
        );
        drop(first);
        let third = peers.try_acquire(a).expect("a dropped permit is returned");
        drop((second, third));
        assert!(peers.counts.lock().is_empty());
    }

    /// All addresses in an IPv6 `/64` share one share: a host cannot
    /// sidestep the cap by picking a fresh address per socket.
    #[test]
    fn test_ipv6_peers_are_counted_by_their_64() {
        let peers = PeerHandshakes::new(2);
        let _a = peers.try_acquire(ip("2001:db8:1:2::1")).unwrap();
        let _b = peers.try_acquire(ip("2001:db8:1:2:ffff::9")).unwrap();
        assert!(peers.try_acquire(ip("2001:db8:1:2:abcd::1")).is_err());
        assert!(
            peers.try_acquire(ip("2001:db8:1:3::1")).unwrap().is_some(),
            "the next /64 is another host"
        );
    }

    /// Loopback peers (every client of a local reverse proxy or `ssh -L`
    /// tunnel) take no per-address permit; only the pool bounds them. A
    /// per-address cap would put all of them in one bucket of
    /// `max_pending_handshakes_per_peer`.
    #[test]
    fn test_loopback_peers_have_no_per_address_share() {
        let peers = PeerHandshakes::new(1);
        for text in ["127.0.0.1", "127.0.0.2", "::1", "::ffff:127.0.0.1"] {
            for _ in 0..3 {
                assert!(peers.try_acquire(ip(text)).unwrap().is_none(), "{text}");
            }
        }
        assert!(peers.counts.lock().is_empty());
    }

    #[test]
    fn test_bearer_token_parsing() {
        let headers = |value: &'static str| {
            let mut headers = HeaderMap::new();
            headers.insert(header::AUTHORIZATION, HeaderValue::from_static(value));
            headers
        };
        assert_eq!(bearer_token(&headers("Bearer abc")), Some("abc"));
        assert_eq!(bearer_token(&headers("bearer abc")), Some("abc"));
        assert_eq!(bearer_token(&headers("Basic abc")), None);
        assert_eq!(bearer_token(&headers("Bearer")), None);
        assert_eq!(bearer_token(&HeaderMap::new()), None);
    }
}
