//! Bound on preview frames in transit from a native thread to the JS thread.

use std::sync::atomic::{AtomicUsize, Ordering};

/// Counts preview frames handed to the ThreadsafeFunction but not yet run on
/// the JS thread, and refuses new ones past `cap`.
///
/// It replaces Node's own `max_queue_size`: when that queue is full,
/// `napi_call_threadsafe_function` returns `napi_queue_full` without taking
/// the payload, and napi-rs 2 has already leaked it with `Box::into_raw` — a
/// whole preview buffer per dropped frame, exactly when the JS thread is
/// already struggling. With the gate the frame is refused before anything is
/// allocated or queued, and Node's queue is left unbounded so it never
/// reports `queue_full`.
pub struct PreviewGate {
    pending: AtomicUsize,
    cap: usize,
}

impl PreviewGate {
    pub const fn new(cap: usize) -> Self {
        Self {
            pending: AtomicUsize::new(0),
            cap,
        }
    }

    /// Reserve a slot for one frame. `false` means drop the frame.
    pub fn try_acquire(&self) -> bool {
        self.pending
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                (n < self.cap).then_some(n + 1)
            })
            .is_ok()
    }

    /// Return a slot: the frame ran on the JS thread, or was never queued.
    pub fn release(&self) {
        let _ = self
            .pending
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| n.checked_sub(1));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn admits_up_to_cap_then_refuses() {
        let gate = PreviewGate::new(2);
        assert!(gate.try_acquire());
        assert!(gate.try_acquire());
        assert!(
            !gate.try_acquire(),
            "a third frame in transit must be refused"
        );
    }

    #[test]
    fn release_makes_room_again() {
        let gate = PreviewGate::new(2);
        assert!(gate.try_acquire());
        assert!(gate.try_acquire());
        gate.release();
        assert!(gate.try_acquire());
        assert!(!gate.try_acquire());
    }

    #[test]
    fn release_without_acquire_never_underflows() {
        let gate = PreviewGate::new(1);
        gate.release();
        assert!(gate.try_acquire());
        assert!(
            !gate.try_acquire(),
            "a stray release must not grant extra capacity"
        );
    }

    #[test]
    fn concurrent_producers_never_exceed_cap() {
        let gate = Arc::new(PreviewGate::new(2));
        let in_transit = Arc::new(AtomicUsize::new(0));
        let max_seen = Arc::new(AtomicUsize::new(0));
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let (gate, in_transit, max_seen) =
                    (gate.clone(), in_transit.clone(), max_seen.clone());
                std::thread::spawn(move || {
                    use std::sync::atomic::Ordering::SeqCst;
                    for _ in 0..20_000 {
                        if !gate.try_acquire() {
                            continue;
                        }
                        let now = in_transit.fetch_add(1, SeqCst) + 1;
                        max_seen.fetch_max(now, SeqCst);
                        in_transit.fetch_sub(1, SeqCst);
                        gate.release();
                    }
                })
            })
            .collect();
        for t in threads {
            t.join().unwrap();
        }
        assert!(max_seen.load(std::sync::atomic::Ordering::SeqCst) <= 2);
    }
}
