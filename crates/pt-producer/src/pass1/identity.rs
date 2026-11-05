use std::collections::HashMap;
use std::hash::Hash;

pub struct IdentityInterner<K: Hash + Eq + Ord + Clone> {
    by_key: HashMap<K, u32>,
    keys: Vec<K>,
}

impl<K: Hash + Eq + Ord + Clone> Default for IdentityInterner<K> {
    fn default() -> Self {
        Self {
            by_key: HashMap::new(),
            keys: Vec::new(),
        }
    }
}

impl<K: Hash + Eq + Ord + Clone> IdentityInterner<K> {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn intern(&mut self, key: K) -> u32 {
        if let Some(&id) = self.by_key.get(&key) {
            return id;
        }
        let id = self.keys.len() as u32;
        self.keys.push(key.clone());
        self.by_key.insert(key, id);
        id
    }

    pub fn len(&self) -> usize {
        self.keys.len()
    }

    pub fn is_empty(&self) -> bool {
        self.keys.is_empty()
    }

    pub fn finalize(self) -> InternTable<K> {
        let pre_keys = self.keys;
        let n = pre_keys.len();
        let mut indexed: Vec<(usize, K)> = pre_keys.into_iter().enumerate().collect();
        indexed.sort_by(|a, b| a.1.cmp(&b.1));
        let mut remap = vec![0u32; n];
        let mut sorted_keys = Vec::with_capacity(n);
        let mut by_key = HashMap::with_capacity(n);
        for (post_id, (pre_id, key)) in indexed.into_iter().enumerate() {
            remap[pre_id] = post_id as u32;
            by_key.insert(key.clone(), post_id as u32);
            sorted_keys.push(key);
        }
        InternTable {
            keys: sorted_keys,
            by_key,
            remap,
        }
    }
}

pub struct InternTable<K: Hash + Eq + Ord + Clone> {
    keys: Vec<K>,
    by_key: HashMap<K, u32>,
    remap: Vec<u32>,
}

impl<K: Hash + Eq + Ord + Clone> InternTable<K> {
    pub fn lookup<Q>(&self, key: &Q) -> Option<u32>
    where
        K: std::borrow::Borrow<Q>,
        Q: Hash + Eq + ?Sized,
    {
        self.by_key.get(key).copied()
    }
    pub fn remap(&self) -> &[u32] {
        &self.remap
    }
    pub fn keys(&self) -> &[K] {
        &self.keys
    }
    pub fn len(&self) -> usize {
        self.keys.len()
    }
    pub fn is_empty(&self) -> bool {
        self.keys.is_empty()
    }
}
