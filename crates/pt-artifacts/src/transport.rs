//! HTTPS-only mirror transport. Object URLs are derived from signed hashes;
//! redirects, credentials, query strings and content transformations are refused.
use crate::install::Repository;
use std::{
    io::{self, Read},
    time::Duration,
};

pub struct HttpsRepository {
    base: url::Url,
    agent: ureq::Agent,
}
impl HttpsRepository {
    pub fn new(base: &str) -> io::Result<Self> {
        let mut base = url::Url::parse(base).map_err(io::Error::other)?;
        if base.scheme() != "https"
            || base.host_str().is_none()
            || !base.username().is_empty()
            || base.password().is_some()
            || base.query().is_some()
            || base.fragment().is_some()
        {
            return Err(io::Error::other(
                "artifact source must be a plain HTTPS base URL",
            ));
        }
        if !base.path().ends_with('/') {
            base.set_path(&format!("{}/", base.path()));
        }
        let agent = ureq::AgentBuilder::new()
            .redirects(0)
            .timeout_connect(Duration::from_secs(15))
            .timeout_read(Duration::from_secs(60))
            .timeout(Duration::from_secs(600))
            .build();
        Ok(Self { base, agent })
    }
}
impl Repository for HttpsRepository {
    fn open(&self, relative: &str) -> io::Result<Box<dyn Read>> {
        if relative.starts_with('/')
            || relative
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == "..")
            || relative
                .bytes()
                .any(|b| !b.is_ascii_alphanumeric() && !b"/.-".contains(&b))
        {
            return Err(io::Error::other("unsafe repository URL path"));
        }
        let url = self.base.join(relative).map_err(io::Error::other)?;
        for attempt in 0..3 {
            match self
                .agent
                .get(url.as_str())
                .set("Accept-Encoding", "identity")
                .call()
            {
                Ok(response) => {
                    if response.status() != 200
                        || response
                            .header("Content-Encoding")
                            .is_some_and(|v| v != "identity")
                    {
                        return Err(io::Error::other(
                            "unexpected artifact response or content encoding",
                        ));
                    }
                    return Ok(response.into_reader());
                }
                Err(error) => {
                    let retry = match &error {
                        ureq::Error::Status(code, _) => *code == 429 || *code >= 500,
                        ureq::Error::Transport(_) => true,
                    };
                    if !retry || attempt == 2 {
                        return Err(io::Error::other(error.to_string()));
                    }
                    std::thread::sleep(Duration::from_secs(1 << attempt));
                }
            }
        }
        unreachable!()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restricts_source_and_paths() {
        for url in [
            "http://example.org",
            "https://user:secret@example.org",
            "https://example.org/?token=secret",
            "https://example.org/#fragment",
        ] {
            assert!(HttpsRepository::new(url).is_err());
        }
        let repo = HttpsRepository::new("https://example.org/artifacts").unwrap();
        for path in [
            "../escape",
            "//elsewhere/object",
            "objects/%2e%2e/private",
            "objects/a?query",
        ] {
            assert!(repo.open(path).is_err());
        }
    }
}
