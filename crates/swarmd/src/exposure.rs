//! The plaintext exposure gate: which network a connection crosses, judged
//! from BOTH of its ends, and whether `swarmd` serves it over plain `ws://`.
//!
//! The daemon speaks plaintext only (TLS is a later release), and its token
//! is shell access as the daemon's user, so the network a connection crosses
//! decides whether it is served at all:
//!
//! - [`Exposure::Loopback`]: both ends are loopback. Always served; this is
//!   also every client of an `ssh -L` tunnel or a reverse proxy on this
//!   machine.
//! - [`Exposure::PrivateLan`]: both ends are loopback or private IPv4
//!   (RFC 1918, or the RFC 6598 shared space `100.64.0.0/10`), plain or
//!   IPv4-mapped, and at least one is not loopback. Served only when the
//!   operator passed `--allow-plaintext-lan` ([`ExposurePolicy::new`]).
//!   `100.64.0.0/10` is carrier-grade NAT space that tailnets share with
//!   carriers and other VPNs, so it is private space here, never proof of a
//!   tailnet.
//! - [`Exposure::Public`]: anything else (a public or link-local address,
//!   every native IPv6 address but `::1`, a local address the OS could not
//!   report). Never served in plaintext.
//!
//! Both ends count because either one alone can hide the internet: a public
//! peer on a private interface came in through a router's port forward, and
//! a private peer on a public interface means that interface itself faces
//! the internet. The gate runs on every request, in the router-wide
//! request layer ([`crate::router`]) before the `Host`/`Origin` allow-list,
//! and again in the `/ws` upgrade before the upgrade takes any admission
//! slot. `main` also refuses at startup a concrete `--bind` address no
//! connection on which could be served ([`ExposurePolicy::check_bind`]).
//!
//! This is not a firewall: it decides what `swarmd` serves, not what can
//! reach the port.

use std::fmt;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};

use crate::ConnectionAddrs;

/// The network of `100.64.0.0/10`, the RFC 6598 shared address space
/// (carrier-grade NAT). `Ipv4Addr::is_shared` would name it, but it is still
/// unstable (`feature(ip)`, rust-lang/rust#27709) on the pinned nightly, and
/// no Swarm crate enables a nightly feature.
const SHARED_SPACE: Ipv4Addr = Ipv4Addr::new(100, 64, 0, 0);
/// The `/10` netmask of [`SHARED_SPACE`].
const SHARED_SPACE_MASK: u32 = !(u32::MAX >> 10);

/// Whether `ip` lies in [`SHARED_SPACE`].
const fn is_shared_space(ip: Ipv4Addr) -> bool {
    ip.to_bits() & SHARED_SPACE_MASK == SHARED_SPACE.to_bits()
}

/// The network a connection crosses, ordered from the narrowest to the
/// widest (see the module doc).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Exposure {
    /// Both ends are loopback.
    Loopback,
    /// Both ends are loopback or private IPv4, at least one not loopback.
    PrivateLan,
    /// Anything wider, or an end that could not be read.
    Public,
}

impl Exposure {
    /// The class of one address, IPv4-mapped IPv6 read as IPv4.
    const fn of(ip: IpAddr) -> Self {
        match ip.to_canonical() {
            IpAddr::V4(v4) if v4.is_loopback() => Self::Loopback,
            IpAddr::V4(v4) if v4.is_private() || is_shared_space(v4) => Self::PrivateLan,
            IpAddr::V6(v6) if v6.is_loopback() => Self::Loopback,
            IpAddr::V4(_) | IpAddr::V6(_) => Self::Public,
        }
    }
}

impl fmt::Display for Exposure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Loopback => "Loopback",
            Self::PrivateLan => "Private LAN",
            Self::Public => "Public",
        })
    }
}

/// Classifies a connection by both of its ends: the wider of the two
/// addresses' classes. `local` is `None` when the OS could not report the
/// interface the connection arrived on, which classifies as
/// [`Exposure::Public`]: an unknown end is never assumed private.
pub fn classify(remote: IpAddr, local: Option<IpAddr>) -> Exposure {
    local.map_or(Exposure::Public, |local| {
        Exposure::of(remote).max(Exposure::of(local))
    })
}

/// Why [`ExposurePolicy`] refused a connection or a bind. `Display` is the
/// Title Case message sent in the 403 body and printed at startup.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum Refusal {
    #[error("Plaintext Connections Over A Private LAN Need --allow-plaintext-lan.")]
    LanNotAllowed,
    #[error("Plaintext Connections Are Served Only On Loopback And Private IPv4 Networks.")]
    NotPrivate,
}

/// Which [`Exposure`] classes the daemon serves (see the module doc).
/// The default serves loopback only.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ExposurePolicy {
    allow_plaintext_lan: bool,
}

impl ExposurePolicy {
    /// A policy that serves [`Exposure::Loopback`], plus
    /// [`Exposure::PrivateLan`] when `allow_plaintext_lan`
    /// (`--allow-plaintext-lan`).
    pub const fn new(allow_plaintext_lan: bool) -> Self {
        Self {
            allow_plaintext_lan,
        }
    }

    /// The widest class this policy serves.
    pub const fn widest(self) -> Exposure {
        if self.allow_plaintext_lan {
            Exposure::PrivateLan
        } else {
            Exposure::Loopback
        }
    }

    /// Whether a connection of class `exposure` is served.
    ///
    /// # Errors
    ///
    /// The [`Refusal`] naming what the connection would need.
    pub const fn admit(self, exposure: Exposure) -> Result<(), Refusal> {
        match exposure {
            Exposure::Loopback => Ok(()),
            Exposure::PrivateLan if self.allow_plaintext_lan => Ok(()),
            Exposure::PrivateLan => Err(Refusal::LanNotAllowed),
            Exposure::Public => Err(Refusal::NotPrivate),
        }
    }

    /// Checks one connection by its two ends (see [`classify`]) and returns
    /// its class.
    ///
    /// # Errors
    ///
    /// The [`Refusal`] for a connection this policy does not serve.
    pub fn check(self, remote: SocketAddr, local: Option<SocketAddr>) -> Result<Exposure, Refusal> {
        let exposure = classify(remote.ip(), local.map(|local| local.ip()));
        self.admit(exposure).map(|()| exposure)
    }

    /// Checks a `--bind` address before anything binds it. Every connection
    /// accepted on a concrete address has that address as its local end, so
    /// its class is at least the address's own: if the policy refuses that,
    /// it refuses every connection the bind could accept, and the daemon
    /// should not start. A wildcard address is decided per connection.
    ///
    /// # Errors
    ///
    /// The [`Refusal`] every connection on `bind` would get.
    pub fn check_bind(self, bind: IpAddr) -> Result<(), Refusal> {
        if bind.to_canonical().is_unspecified() {
            return Ok(());
        }
        self.admit(classify(bind, Some(bind)))
    }
}

impl fmt::Display for ExposurePolicy {
    /// The status line's summary of what is served.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(if self.allow_plaintext_lan {
            "Loopback And Private IPv4 Networks (RFC 1918, 100.64.0.0/10)"
        } else {
            "Loopback Only"
        })
    }
}

/// Runs `policy` on one request's connection for the request layer and the
/// `/ws` upgrade: `None` when it is served, otherwise the 403 to answer
/// with, logged with both ends. A request without connection addresses (a
/// router served without [`ConnectionAddrs`] as its `ConnectInfo`) has no
/// ends to judge and is refused as [`Exposure::Public`].
pub(crate) fn refusal(policy: ExposurePolicy, addrs: Option<ConnectionAddrs>) -> Option<Response> {
    let refusal = match addrs {
        Some(ConnectionAddrs { remote, local }) => policy.check(remote, local).err()?,
        None => Refusal::NotPrivate,
    };
    tracing::warn!(
        peer = ?addrs.map(|addrs| addrs.remote),
        local = ?addrs.and_then(|addrs| addrs.local),
        %refusal,
        "plaintext connection refused by the exposure gate"
    );
    Some((StatusCode::FORBIDDEN, refusal.to_string()).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(raw: &str) -> IpAddr {
        raw.parse().unwrap()
    }

    #[test]
    fn test_single_address_classes() {
        let table = [
            ("127.0.0.1", Exposure::Loopback),
            ("127.255.0.9", Exposure::Loopback),
            ("::1", Exposure::Loopback),
            ("::ffff:127.0.0.1", Exposure::Loopback),
            ("10.0.0.1", Exposure::PrivateLan),
            ("10.255.255.255", Exposure::PrivateLan),
            ("172.16.0.1", Exposure::PrivateLan),
            ("172.31.255.254", Exposure::PrivateLan),
            ("192.168.1.5", Exposure::PrivateLan),
            ("::ffff:192.168.1.5", Exposure::PrivateLan),
            ("100.64.0.0", Exposure::PrivateLan),
            ("100.100.100.100", Exposure::PrivateLan),
            ("100.127.255.255", Exposure::PrivateLan),
            ("::ffff:100.64.0.1", Exposure::PrivateLan),
            // Just outside each private range.
            ("100.63.255.255", Exposure::Public),
            ("100.128.0.0", Exposure::Public),
            ("172.15.255.255", Exposure::Public),
            ("172.32.0.0", Exposure::Public),
            ("192.169.0.1", Exposure::Public),
            ("11.0.0.1", Exposure::Public),
            ("8.8.8.8", Exposure::Public),
            // Link-local, unspecified and broadcast are not a LAN class.
            ("169.254.1.1", Exposure::Public),
            ("0.0.0.0", Exposure::Public),
            ("255.255.255.255", Exposure::Public),
            // Native IPv6 beyond loopback: ULA (the Tailscale prefix
            // fd7a:115c:a1e0::/48 among it), link-local, global, and the
            // deprecated IPv4-compatible form, which is not IPv4-mapped.
            ("fd7a:115c:a1e0::1", Exposure::Public),
            ("fc00::1", Exposure::Public),
            ("fe80::1", Exposure::Public),
            ("2001:db8::1", Exposure::Public),
            ("::", Exposure::Public),
            ("::192.168.1.5", Exposure::Public),
        ];
        for (raw, expected) in table {
            assert_eq!(classify(ip(raw), Some(ip(raw))), expected, "{raw}");
        }
    }

    #[test]
    fn test_the_wider_end_decides() {
        let table = [
            ("127.0.0.1", Some("127.0.0.1"), Exposure::Loopback),
            ("::1", Some("::ffff:127.0.0.1"), Exposure::Loopback),
            ("192.168.1.9", Some("192.168.1.5"), Exposure::PrivateLan),
            ("127.0.0.1", Some("10.0.0.2"), Exposure::PrivateLan),
            ("::ffff:10.0.0.3", Some("10.0.0.2"), Exposure::PrivateLan),
            ("100.101.102.103", Some("100.64.0.7"), Exposure::PrivateLan),
            // A private peer on an internet-facing interface, and a public
            // peer port-forwarded to a private one.
            ("192.168.1.9", Some("203.0.113.4"), Exposure::Public),
            ("203.0.113.4", Some("192.168.1.5"), Exposure::Public),
            ("fd00::2", Some("::1"), Exposure::Public),
            ("127.0.0.1", Some("fe80::1"), Exposure::Public),
            // An end the OS could not report is never assumed private.
            ("127.0.0.1", None, Exposure::Public),
            ("192.168.1.9", None, Exposure::Public),
        ];
        for (remote, local, expected) in table {
            assert_eq!(
                classify(ip(remote), local.map(ip)),
                expected,
                "{remote} -> {local:?}"
            );
        }
    }

    #[test]
    fn test_the_policy_serves_lan_only_with_the_override() {
        let strict = ExposurePolicy::default();
        let lan = ExposurePolicy::new(true);
        assert_eq!(strict, ExposurePolicy::new(false));

        assert_eq!(strict.admit(Exposure::Loopback), Ok(()));
        assert_eq!(
            strict.admit(Exposure::PrivateLan),
            Err(Refusal::LanNotAllowed)
        );
        assert_eq!(strict.admit(Exposure::Public), Err(Refusal::NotPrivate));
        assert_eq!(lan.admit(Exposure::Loopback), Ok(()));
        assert_eq!(lan.admit(Exposure::PrivateLan), Ok(()));
        assert_eq!(lan.admit(Exposure::Public), Err(Refusal::NotPrivate));

        assert_eq!(strict.widest(), Exposure::Loopback);
        assert_eq!(lan.widest(), Exposure::PrivateLan);

        let addr = |raw: &str| raw.parse::<SocketAddr>().unwrap();
        assert_eq!(
            strict.check(addr("127.0.0.1:50000"), Some(addr("127.0.0.1:8787"))),
            Ok(Exposure::Loopback)
        );
        assert_eq!(
            strict.check(addr("192.168.1.9:50000"), Some(addr("192.168.1.5:8787"))),
            Err(Refusal::LanNotAllowed)
        );
        assert_eq!(
            lan.check(addr("192.168.1.9:50000"), Some(addr("192.168.1.5:8787"))),
            Ok(Exposure::PrivateLan)
        );
        assert_eq!(
            lan.check(addr("[::ffff:192.168.1.9]:50000"), None),
            Err(Refusal::NotPrivate)
        );
    }

    #[test]
    fn test_a_bind_no_connection_could_use_is_refused() {
        let strict = ExposurePolicy::default();
        let lan = ExposurePolicy::new(true);
        for wildcard in ["0.0.0.0", "::", "::ffff:0.0.0.0"] {
            assert_eq!(strict.check_bind(ip(wildcard)), Ok(()), "{wildcard}");
        }
        assert_eq!(strict.check_bind(ip("127.0.0.1")), Ok(()));
        assert_eq!(strict.check_bind(ip("::1")), Ok(()));
        assert_eq!(
            strict.check_bind(ip("192.168.1.5")),
            Err(Refusal::LanNotAllowed)
        );
        assert_eq!(lan.check_bind(ip("192.168.1.5")), Ok(()));
        assert_eq!(lan.check_bind(ip("100.64.0.7")), Ok(()));
        for public in ["203.0.113.4", "fd7a:115c:a1e0::1", "fe80::1"] {
            assert_eq!(
                lan.check_bind(ip(public)),
                Err(Refusal::NotPrivate),
                "{public}"
            );
        }
    }

    #[test]
    fn test_the_status_summary_names_what_is_served() {
        assert_eq!(ExposurePolicy::default().to_string(), "Loopback Only");
        assert!(
            ExposurePolicy::new(true)
                .to_string()
                .starts_with("Loopback And Private IPv4 Networks")
        );
    }
}
