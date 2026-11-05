//! Bounded accounting for exact winner journey projection.
use crate::engine::EngineError;
use core::cell::Cell;
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct Work {
    pub stop: usize,
    pub lookup: usize,
    pub states: usize,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Exhaustion {
    Stop { limit: usize, attempted: usize },
    Lookup { limit: usize, attempted: usize },
    States { limit: usize, attempted: usize },
    Local,
}
pub(crate) struct PlanMeter {
    limits: Work,
    consumed: Work,
    local: Work,
    work: Cell<Work>,
    exhaustion: Cell<Option<Exhaustion>>,
}
impl PlanMeter {
    pub fn new(limits: Work, consumed: Work, local: Work) -> Self {
        Self {
            limits,
            consumed,
            local,
            work: Cell::new(Work::default()),
            exhaustion: Cell::new(None),
        }
    }
    pub fn work(&self) -> Work {
        self.work.get()
    }
    pub fn exhaustion(&self) -> Option<Exhaustion> {
        self.exhaustion.get()
    }
    fn charge(&self, kind: u8) -> Result<(), EngineError> {
        if self.exhaustion.get().is_some() {
            return Err(EngineError::Aborted);
        }
        let mut w = self.work.get();
        let (n, used, limit, local) = match kind {
            0 => (
                &mut w.stop,
                self.consumed.stop,
                self.limits.stop,
                self.local.stop,
            ),
            1 => (
                &mut w.lookup,
                self.consumed.lookup,
                self.limits.lookup,
                self.local.lookup,
            ),
            _ => (
                &mut w.states,
                self.consumed.states,
                self.limits.states,
                self.local.states,
            ),
        };
        let attempted = used
            .checked_add(*n)
            .and_then(|n| n.checked_add(1))
            .ok_or(EngineError::TimeOverflow)?;
        let reason = if attempted > limit {
            Some(match kind {
                0 => Exhaustion::Stop { limit, attempted },
                1 => Exhaustion::Lookup { limit, attempted },
                _ => Exhaustion::States { limit, attempted },
            })
        } else if *n >= local {
            Some(Exhaustion::Local)
        } else {
            None
        };
        if let Some(reason) = reason {
            self.exhaustion.set(Some(reason));
            return Err(EngineError::Aborted);
        }
        *n += 1;
        self.work.set(w);
        Ok(())
    }
    pub fn stop(&self) -> Result<(), EngineError> {
        self.charge(0)
    }
    pub fn lookup(&self) -> Result<(), EngineError> {
        self.charge(1)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn global_limits_precede_local_cutoffs_and_keep_original_attempts() {
        let m = PlanMeter::new(
            Work {
                stop: 11,
                lookup: 8,
                states: 3,
            },
            Work {
                stop: 10,
                lookup: 7,
                states: 2,
            },
            Work {
                stop: 1,
                lookup: 1,
                states: 1,
            },
        );
        m.stop().unwrap();
        assert_eq!(m.stop(), Err(EngineError::Aborted));
        assert_eq!(
            m.exhaustion(),
            Some(Exhaustion::Stop {
                limit: 11,
                attempted: 12
            })
        );
        let m = PlanMeter::new(
            Work {
                stop: 100,
                lookup: 100,
                states: 100,
            },
            Work::default(),
            Work {
                stop: 1,
                lookup: 1,
                states: 1,
            },
        );
        m.lookup().unwrap();
        assert_eq!(m.lookup(), Err(EngineError::Aborted));
        assert_eq!(m.exhaustion(), Some(Exhaustion::Local));
        assert_eq!(m.work().lookup, 1);
    }
}
