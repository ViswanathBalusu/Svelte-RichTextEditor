//! The font faces the kernel holds (WASM-005; 02 §3, §6; 09 §5).
//!
//! A face is the bytes of one font file, identified by its SHA-256 hash, which is also what the
//! editor's alias is made from (`de-font-<hash>`). The kernel checks every file against the hash
//! the manifest gives, whoever sends it, and refuses a file that does not match. It holds each face
//! once, under its alias, for the owner that asked for it: the platform's own fonts, or one
//! tenant's. A face of one owner is never given to another (a tenant's own font is licensed to that
//! tenant), and releasing an owner frees exactly its faces.
//!
//! The font epoch (02 §6) counts the loads. Every cache the kernel keeps for a face is keyed by the
//! epoch at which the face was loaded, so a later load of a face makes the caches of its earlier
//! epoch miss (the shaping cache is in `shaping.rs`).
//!
//! What a face holds is the caller's choice (`F`): the kernel keeps a parsed font, the tests keep the
//! bytes. The store only needs the length of the file, for the memory it reports.
//!
//! The store takes no clock and reads no file; the caller gives bytes.

use std::collections::BTreeMap;

use crate::sha256::sha256_hex;

/// Why a face was refused. The text of `code` is part of the call interface.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FaceError {
    /// The alias is empty.
    EmptyAlias,
    /// The hash the caller gave is not 64 lowercase hexadecimal digits.
    BadHash,
    /// The file's SHA-256 is not the hash the manifest gave.
    HashMismatch,
    /// The file is not a TrueType or OpenType font (it has no `sfnt` header).
    NotAFont,
    /// Another owner holds a face under this alias.
    OwnerConflict,
}

impl FaceError {
    /// The code that crosses the boundary.
    pub fn code(self) -> &'static str {
        match self {
            FaceError::EmptyAlias => "empty_alias",
            FaceError::BadHash => "bad_hash",
            FaceError::HashMismatch => "hash_mismatch",
            FaceError::NotAFont => "not_a_font",
            FaceError::OwnerConflict => "owner_conflict",
        }
    }
}

/// What a load did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Loaded {
    /// The face was new: it is held now and the epoch advanced.
    New,
    /// The same face was held already for this owner: nothing changed.
    Already,
}

struct Face<F> {
    owner: String,
    hash: String,
    /// The size of the file, in bytes.
    size: usize,
    /// The epoch at which this face was loaded.
    loaded_epoch: u32,
    payload: F,
}

/// The faces of one kernel instance, by alias.
pub struct FaceStore<F> {
    faces: BTreeMap<String, Face<F>>,
    epoch: u32,
}

fn is_hash(text: &str) -> bool {
    text.len() == 64
        && text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

impl<F> Default for FaceStore<F> {
    fn default() -> Self {
        Self::new()
    }
}

impl<F> FaceStore<F> {
    pub const fn new() -> Self {
        Self {
            faces: BTreeMap::new(),
            epoch: 0,
        }
    }

    /// Holds the face `bytes` under `alias` for `owner`, if `bytes` hash to `expected_hash` and
    /// `parse` makes a face of them (`None` is a file that is not a font).
    pub fn load(
        &mut self,
        owner: &str,
        alias: &str,
        expected_hash: &str,
        bytes: &[u8],
        parse: impl FnOnce(&[u8]) -> Option<F>,
    ) -> Result<Loaded, FaceError> {
        if alias.is_empty() {
            return Err(FaceError::EmptyAlias);
        }
        if !is_hash(expected_hash) {
            return Err(FaceError::BadHash);
        }
        if let Some(held) = self.faces.get(alias) {
            if held.owner != owner {
                return Err(FaceError::OwnerConflict);
            }
            if held.hash == expected_hash {
                return Ok(Loaded::Already);
            }
        }
        // The hash is checked before anything is kept, and before the header is looked at: a file
        // that is not the one the manifest names is refused whatever it contains.
        if sha256_hex(bytes) != expected_hash {
            return Err(FaceError::HashMismatch);
        }
        let Some(payload) = parse(bytes) else {
            return Err(FaceError::NotAFont);
        };
        self.epoch = self.epoch.wrapping_add(1);
        self.faces.insert(
            alias.to_string(),
            Face {
                owner: owner.to_string(),
                hash: expected_hash.to_string(),
                size: bytes.len(),
                loaded_epoch: self.epoch,
                payload,
            },
        );
        Ok(Loaded::New)
    }

    /// Frees the face under `alias`. True when there was one.
    pub fn release(&mut self, alias: &str) -> bool {
        self.faces.remove(alias).is_some()
    }

    /// Frees every face of `owner`. Returns how many.
    pub fn release_owner(&mut self, owner: &str) -> u32 {
        let before = self.faces.len();
        self.faces.retain(|_, face| face.owner != owner);
        (before - self.faces.len()) as u32
    }

    /// Frees every face.
    pub fn release_all(&mut self) {
        self.faces.clear();
    }

    pub fn has(&self, alias: &str) -> bool {
        self.faces.contains_key(alias)
    }

    /// The owner that holds `alias`.
    pub fn owner(&self, alias: &str) -> Option<&str> {
        self.faces.get(alias).map(|face| face.owner.as_str())
    }

    /// The face under `alias`, for shaping.
    pub fn get(&self, alias: &str) -> Option<&F> {
        self.faces.get(alias).map(|face| &face.payload)
    }

    /// The epoch at which the face under `alias` was loaded. A cache entry made for the face is
    /// valid only while this is the epoch it was made at.
    pub fn loaded_epoch(&self, alias: &str) -> Option<u32> {
        self.faces.get(alias).map(|face| face.loaded_epoch)
    }

    /// The size of the file of the face under `alias`, in bytes; 0 when none is held.
    pub fn size(&self, alias: &str) -> usize {
        self.faces.get(alias).map_or(0, |face| face.size)
    }

    /// The number of faces held.
    pub fn count(&self) -> usize {
        self.faces.len()
    }

    /// The bytes of all the faces held (the memory they take, apart from the module's own).
    pub fn bytes_held(&self) -> usize {
        self.faces.values().map(|face| face.size).sum()
    }

    /// The font epoch: the number of faces loaded so far.
    pub fn epoch(&self) -> u32 {
        self.epoch
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// True when `bytes` start like a TrueType, OpenType or collection file: what a test face is.
    fn is_sfnt(bytes: &[u8]) -> bool {
        matches!(
            bytes.get(..4),
            Some([0x00, 0x01, 0x00, 0x00] | b"OTTO" | b"true" | b"ttcf")
        )
    }

    /// The tests keep the bytes as the face.
    fn parse(bytes: &[u8]) -> Option<Vec<u8>> {
        is_sfnt(bytes).then(|| bytes.to_vec())
    }

    fn sha256_hex(bytes: &[u8]) -> String {
        crate::sha256::sha256_hex(bytes)
    }

    type Store = FaceStore<Vec<u8>>;

    /// A file that has the `sfnt` header and nothing else: enough for the store.
    fn font(extra: u8) -> Vec<u8> {
        let mut bytes = vec![0x00, 0x01, 0x00, 0x00];
        bytes.extend_from_slice(&[extra; 28]);
        bytes
    }

    fn load(
        store: &mut Store,
        owner: &str,
        alias: &str,
        bytes: &[u8],
    ) -> Result<Loaded, FaceError> {
        store.load(owner, alias, &sha256_hex(bytes), bytes, parse)
    }

    #[test]
    fn holds_a_face_whose_hash_matches_and_counts_the_load() {
        let mut store = Store::new();
        let bytes = font(1);
        assert_eq!(load(&mut store, "", "de-font-a", &bytes), Ok(Loaded::New));
        assert!(store.has("de-font-a"));
        assert_eq!(store.size("de-font-a"), 32);
        assert_eq!(store.bytes_held(), 32);
        assert_eq!(store.count(), 1);
        assert_eq!(store.epoch(), 1);
        assert_eq!(store.loaded_epoch("de-font-a"), Some(1));
        assert_eq!(store.get("de-font-a"), Some(&bytes));
    }

    #[test]
    fn refuses_a_file_whose_hash_is_not_the_manifests() {
        let mut store = Store::new();
        let bytes = font(1);
        let other = sha256_hex(&font(2));
        assert_eq!(
            store.load("", "de-font-a", &other, &bytes, parse),
            Err(FaceError::HashMismatch)
        );
        assert!(!store.has("de-font-a"));
        assert_eq!(store.epoch(), 0);
        // A damaged copy of a good file is refused the same way.
        let mut damaged = bytes.clone();
        damaged[10] ^= 1;
        let hash = sha256_hex(&bytes);
        assert_eq!(
            store.load("", "de-font-a", &hash, &damaged, parse),
            Err(FaceError::HashMismatch)
        );
        assert_eq!(store.count(), 0);
    }

    #[test]
    fn refuses_a_malformed_hash_an_empty_alias_and_a_file_that_is_not_a_font() {
        let mut store = Store::new();
        let bytes = font(1);
        let hash = sha256_hex(&bytes);
        assert_eq!(
            store.load("", "", &hash, &bytes, parse),
            Err(FaceError::EmptyAlias)
        );
        assert_eq!(
            store.load("", "a", &hash.to_uppercase(), &bytes, parse),
            Err(FaceError::BadHash)
        );
        assert_eq!(
            store.load("", "a", "abc", &bytes, parse),
            Err(FaceError::BadHash)
        );
        let html = b"<!doctype html><title>404</title>".to_vec();
        assert_eq!(load(&mut store, "", "a", &html), Err(FaceError::NotAFont));
        assert_eq!(store.count(), 0);
        assert_eq!(store.epoch(), 0);
    }

    #[test]
    fn loading_the_same_face_again_changes_nothing() {
        let mut store = Store::new();
        let bytes = font(1);
        load(&mut store, "", "a", &bytes).unwrap();
        assert_eq!(load(&mut store, "", "a", &bytes), Ok(Loaded::Already));
        assert_eq!(store.epoch(), 1);
        assert_eq!(store.loaded_epoch("a"), Some(1));
        assert_eq!(store.bytes_held(), 32);
    }

    #[test]
    fn a_new_file_under_an_alias_replaces_the_face_and_gives_it_the_new_epoch() {
        let mut store = Store::new();
        load(&mut store, "", "a", &font(1)).unwrap();
        load(&mut store, "", "b", &font(3)).unwrap();
        assert_eq!(load(&mut store, "", "a", &font(2)), Ok(Loaded::New));
        assert_eq!(store.epoch(), 3);
        assert_eq!(store.count(), 2);
        assert_eq!(store.get("a"), Some(&font(2)));
        // The epoch of each face is the one at which it was loaded: `b` did not move.
        assert_eq!(store.loaded_epoch("a"), Some(3));
        assert_eq!(store.loaded_epoch("b"), Some(2));
    }

    #[test]
    fn a_tenants_face_is_not_given_to_another_owner_and_is_freed_with_its_owner() {
        let mut store = Store::new();
        load(&mut store, "", "shared", &font(1)).unwrap();
        load(&mut store, "tenant:a", "own", &font(2)).unwrap();
        assert_eq!(store.owner("own"), Some("tenant:a"));
        // Another tenant asking for the same file does not get it.
        assert_eq!(
            load(&mut store, "tenant:b", "own", &font(2)),
            Err(FaceError::OwnerConflict)
        );
        // Freeing the tenant leaves the platform's faces.
        assert_eq!(store.release_owner("tenant:a"), 1);
        assert!(!store.has("own"));
        assert!(store.has("shared"));
        // Now the other tenant can hold it.
        assert_eq!(
            load(&mut store, "tenant:b", "own", &font(2)),
            Ok(Loaded::New)
        );
    }

    #[test]
    fn release_frees_the_memory_one_face_or_all() {
        let mut store = Store::new();
        for n in 0..3u8 {
            load(&mut store, "", &format!("face-{n}"), &font(n)).unwrap();
        }
        assert_eq!(store.bytes_held(), 96);
        assert!(store.release("face-1"));
        assert!(!store.release("face-1"));
        assert_eq!(store.bytes_held(), 64);
        store.release_all();
        assert_eq!(store.count(), 0);
        assert_eq!(store.bytes_held(), 0);
    }
}
