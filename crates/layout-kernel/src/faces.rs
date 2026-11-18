//! The font faces the kernel holds (WASM-005; 02 §3, §6; 09 §5).
//!
//! A face is the bytes of one font file, identified by its SHA-256 hash, which is also what the
//! editor's alias is made from (`de-font-<hash>`). The kernel checks every file against the hash
//! the manifest gives, whoever sends it, and refuses a file that does not match. It holds each face
//! once, under its alias, for the owner that asked for it: the platform's own fonts, or one
//! tenant's. A face of one owner is never given to another (a tenant's own font is licensed to that
//! tenant), and releasing an owner frees exactly its faces.
//!
//! The font epoch (02 §6) counts the loads. Every cache the kernel keeps for a face is keyed by it,
//! so a later load makes the caches of the earlier epoch miss (the caches arrive with WASM-006).
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

struct Face {
    owner: String,
    hash: String,
    bytes: Vec<u8>,
}

/// The faces of one kernel instance, by alias.
pub struct FaceStore {
    faces: BTreeMap<String, Face>,
    epoch: u32,
}

/// True when `bytes` start like a TrueType, OpenType or collection file.
fn is_sfnt(bytes: &[u8]) -> bool {
    match bytes.get(..4) {
        Some(tag) => matches!(tag, [0x00, 0x01, 0x00, 0x00] | b"OTTO" | b"true" | b"ttcf"),
        None => false,
    }
}

fn is_hash(text: &str) -> bool {
    text.len() == 64
        && text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

impl Default for FaceStore {
    fn default() -> Self {
        Self::new()
    }
}

impl FaceStore {
    pub const fn new() -> Self {
        Self {
            faces: BTreeMap::new(),
            epoch: 0,
        }
    }

    /// Holds the face `bytes` under `alias` for `owner`, if `bytes` hash to `expected_hash`.
    pub fn load(
        &mut self,
        owner: &str,
        alias: &str,
        expected_hash: &str,
        bytes: &[u8],
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
        if !is_sfnt(bytes) {
            return Err(FaceError::NotAFont);
        }
        self.faces.insert(
            alias.to_string(),
            Face {
                owner: owner.to_string(),
                hash: expected_hash.to_string(),
                bytes: bytes.to_vec(),
            },
        );
        self.epoch = self.epoch.wrapping_add(1);
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

    /// The bytes of the face under `alias`, for shaping.
    pub fn bytes(&self, alias: &str) -> Option<&[u8]> {
        self.faces.get(alias).map(|face| face.bytes.as_slice())
    }

    /// The size of the face under `alias`, in bytes; 0 when none is held.
    pub fn size(&self, alias: &str) -> usize {
        self.faces.get(alias).map_or(0, |face| face.bytes.len())
    }

    /// The number of faces held.
    pub fn count(&self) -> usize {
        self.faces.len()
    }

    /// The bytes of all the faces held (the memory they take, apart from the module's own).
    pub fn bytes_held(&self) -> usize {
        self.faces.values().map(|face| face.bytes.len()).sum()
    }

    /// The font epoch: the number of faces loaded so far.
    pub fn epoch(&self) -> u32 {
        self.epoch
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A file that has the `sfnt` header and nothing else: enough for the store.
    fn font(extra: u8) -> Vec<u8> {
        let mut bytes = vec![0x00, 0x01, 0x00, 0x00];
        bytes.extend_from_slice(&[extra; 28]);
        bytes
    }

    #[test]
    fn holds_a_face_whose_hash_matches_and_counts_the_load() {
        let mut store = FaceStore::new();
        let bytes = font(1);
        let hash = sha256_hex(&bytes);
        assert_eq!(store.load("", "de-font-a", &hash, &bytes), Ok(Loaded::New));
        assert!(store.has("de-font-a"));
        assert_eq!(store.size("de-font-a"), 32);
        assert_eq!(store.bytes_held(), 32);
        assert_eq!(store.count(), 1);
        assert_eq!(store.epoch(), 1);
        assert_eq!(store.bytes("de-font-a"), Some(bytes.as_slice()));
    }

    #[test]
    fn refuses_a_file_whose_hash_is_not_the_manifests() {
        let mut store = FaceStore::new();
        let bytes = font(1);
        let other = sha256_hex(&font(2));
        assert_eq!(
            store.load("", "de-font-a", &other, &bytes),
            Err(FaceError::HashMismatch)
        );
        assert!(!store.has("de-font-a"));
        assert_eq!(store.epoch(), 0);
        // A damaged copy of a good file is refused the same way.
        let mut damaged = bytes.clone();
        damaged[10] ^= 1;
        let hash = sha256_hex(&bytes);
        assert_eq!(
            store.load("", "de-font-a", &hash, &damaged),
            Err(FaceError::HashMismatch)
        );
        assert_eq!(store.count(), 0);
    }

    #[test]
    fn refuses_a_malformed_hash_an_empty_alias_and_a_file_that_is_not_a_font() {
        let mut store = FaceStore::new();
        let bytes = font(1);
        let hash = sha256_hex(&bytes);
        assert_eq!(
            store.load("", "", &hash, &bytes),
            Err(FaceError::EmptyAlias)
        );
        assert_eq!(
            store.load("", "a", &hash.to_uppercase(), &bytes),
            Err(FaceError::BadHash)
        );
        assert_eq!(store.load("", "a", "abc", &bytes), Err(FaceError::BadHash));
        let html = b"<!doctype html><title>404</title>".to_vec();
        let html_hash = sha256_hex(&html);
        assert_eq!(
            store.load("", "a", &html_hash, &html),
            Err(FaceError::NotAFont)
        );
        assert_eq!(store.count(), 0);
    }

    #[test]
    fn loading_the_same_face_again_changes_nothing() {
        let mut store = FaceStore::new();
        let bytes = font(1);
        let hash = sha256_hex(&bytes);
        store.load("", "a", &hash, &bytes).unwrap();
        assert_eq!(store.load("", "a", &hash, &bytes), Ok(Loaded::Already));
        assert_eq!(store.epoch(), 1);
        assert_eq!(store.bytes_held(), 32);
    }

    #[test]
    fn a_new_file_under_an_alias_replaces_the_face_and_advances_the_epoch() {
        let mut store = FaceStore::new();
        let one = font(1);
        let two = font(2);
        store.load("", "a", &sha256_hex(&one), &one).unwrap();
        assert_eq!(
            store.load("", "a", &sha256_hex(&two), &two),
            Ok(Loaded::New)
        );
        assert_eq!(store.epoch(), 2);
        assert_eq!(store.count(), 1);
        assert_eq!(store.bytes("a"), Some(two.as_slice()));
    }

    #[test]
    fn a_tenants_face_is_not_given_to_another_owner_and_is_freed_with_its_owner() {
        let mut store = FaceStore::new();
        let shared = font(1);
        let private = font(2);
        store
            .load("", "shared", &sha256_hex(&shared), &shared)
            .unwrap();
        store
            .load("tenant:a", "own", &sha256_hex(&private), &private)
            .unwrap();
        assert_eq!(store.owner("own"), Some("tenant:a"));
        // Another tenant asking for the same file does not get it.
        assert_eq!(
            store.load("tenant:b", "own", &sha256_hex(&private), &private),
            Err(FaceError::OwnerConflict)
        );
        // Freeing the tenant leaves the platform's faces.
        assert_eq!(store.release_owner("tenant:a"), 1);
        assert!(!store.has("own"));
        assert!(store.has("shared"));
        // Now the other tenant can hold it.
        assert_eq!(
            store.load("tenant:b", "own", &sha256_hex(&private), &private),
            Ok(Loaded::New)
        );
    }

    #[test]
    fn release_frees_the_memory_one_face_or_all() {
        let mut store = FaceStore::new();
        for n in 0..3u8 {
            let bytes = font(n);
            store
                .load("", &format!("face-{n}"), &sha256_hex(&bytes), &bytes)
                .unwrap();
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
