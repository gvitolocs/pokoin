use std::collections::BTreeMap;

use crate::output::RunRecord;

#[derive(Debug, Clone, Default)]
pub struct KindStats {
    pub count: usize,
    pub tool_uses: usize,
    pub ms: Vec<u64>,
}

#[derive(Debug, Clone, Default)]
pub struct SystemStats {
    pub system: String,
    pub count: usize,
    pub errors: usize,
    pub ms: Vec<u64>,
    pub llm_calls: Vec<u32>,
    pub by_kind: BTreeMap<String, KindStats>,
}

impl SystemStats {
    pub fn absorb(&mut self, record: &RunRecord) {
        self.count += 1;
        if record.error.is_some() {
            self.errors += 1;
        }
        self.ms.push(record.ms);
        self.llm_calls.push(record.llm_calls);
        let kind = self
            .by_kind
            .entry(record.kind.clone())
            .or_insert_with(|| KindStats {
                count: 0,
                tool_uses: 0,
                ms: Vec::new(),
            });
        kind.count += 1;
        if !record.tools.is_empty() {
            kind.tool_uses += 1;
        }
        kind.ms.push(record.ms);
    }
}

/// Linear-interpolation percentile on a sorted slice (`p` in 0..=100).
pub fn percentile(sorted: &[u64], p: f64) -> u64 {
    if sorted.is_empty() {
        return 0;
    }
    if sorted.len() == 1 {
        return sorted[0];
    }
    let rank = (p / 100.0) * (sorted.len() as f64 - 1.0);
    let lo = rank.floor() as usize;
    let hi = rank.ceil() as usize;
    if lo == hi {
        sorted[lo]
    } else {
        let weight = rank - lo as f64;
        let value = sorted[lo] as f64 * (1.0 - weight) + sorted[hi] as f64 * weight;
        value.round() as u64
    }
}

pub fn mean_u32(values: &[u32]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let sum = values.iter().map(|value| *value as u64).sum::<u64>();
    sum as f64 / values.len() as f64
}

pub fn tool_rate(uses: usize, count: usize) -> f64 {
    if count == 0 {
        0.0
    } else {
        uses as f64 / count as f64
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percentile_median_and_tail() {
        let data = [10u64, 20, 30, 40, 100];
        assert_eq!(percentile(&data, 50.0), 30);
        assert_eq!(percentile(&data, 95.0), 88);
        assert_eq!(percentile(&data, 0.0), 10);
        assert_eq!(percentile(&data, 100.0), 100);
    }

    #[test]
    fn percentile_single_value() {
        assert_eq!(percentile(&[42], 95.0), 42);
    }

    #[test]
    fn percentile_empty() {
        assert_eq!(percentile(&[], 50.0), 0);
    }
}
