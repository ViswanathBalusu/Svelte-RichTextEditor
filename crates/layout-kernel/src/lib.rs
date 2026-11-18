//! The layout kernel (ADR 0016, decision 2): a compute kernel behind the measurement interface of
//! the layout engine (02 §9.1), compiled to WebAssembly and loaded on demand (WASM-002).
//!
//! WASM-001 is the toolchain: three calls that prove the build and the package end to end. WASM-005
//! adds the font faces (`faces`). The kernel reads no file, no clock and no system font: every input
//! is a byte slice, a string or a number given by the caller, and fonts arrive only as the bytes of
//! the files the manifest names, checked against the manifest's SHA-256.
//!
//! The crate forbids unsafe code. The glue that wasm-bindgen writes is not part of this crate.

#![forbid(unsafe_code)]

use std::cell::RefCell;

use wasm_bindgen::prelude::*;

pub mod faces;
pub mod sha256;

use faces::{FaceStore, Loaded};

thread_local! {
    /// The faces of this instance. A module instance runs on one thread, so the state is per instance.
    static FACES: RefCell<FaceStore> = const { RefCell::new(FaceStore::new()) };
}

/// The version of the call interface. It changes when a call of the kernel changes its meaning, or
/// when a call is added.
pub const ABI_VERSION: u32 = 2;

/// The version of the crate, as `major.minor.patch`.
#[wasm_bindgen]
pub fn kernel_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// The version of the call interface (`ABI_VERSION`).
#[wasm_bindgen]
pub fn abi_version() -> u32 {
    ABI_VERSION
}

/// The 32-bit FNV-1a hash of `data`. A fixed, dependency-free function with a known answer, so that
/// a test in Node.js can tell that bytes cross the boundary and a result comes back unchanged.
#[wasm_bindgen]
pub fn checksum(data: &[u8]) -> u32 {
    let mut hash: u32 = 0x811c_9dc5;
    for byte in data {
        hash ^= u32::from(*byte);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash
}

/// The SHA-256 of `data` as 64 lowercase hexadecimal digits, the form of the font manifest.
#[wasm_bindgen]
pub fn sha256_hex(data: &[u8]) -> String {
    sha256::sha256_hex(data)
}

/// Holds the font file `bytes` under `alias` for `owner` (the empty string is the platform's own
/// fonts, anything else is a tenant), if the file's SHA-256 is `sha256`. Returns 1 when the face is
/// new (the font epoch advanced) and 0 when the same face was held already. Throws an error whose
/// message is the code: `empty_alias`, `bad_hash`, `hash_mismatch`, `not_a_font` or
/// `owner_conflict`.
#[wasm_bindgen]
pub fn face_load(owner: &str, alias: &str, sha256: &str, bytes: &[u8]) -> Result<u32, JsError> {
    FACES.with(
        |faces| match faces.borrow_mut().load(owner, alias, sha256, bytes) {
            Ok(Loaded::New) => Ok(1),
            Ok(Loaded::Already) => Ok(0),
            Err(error) => Err(JsError::new(error.code())),
        },
    )
}

/// Frees the face under `alias`. True when there was one.
#[wasm_bindgen]
pub fn face_release(alias: &str) -> bool {
    FACES.with(|faces| faces.borrow_mut().release(alias))
}

/// Frees every face of `owner`; returns how many.
#[wasm_bindgen]
pub fn face_release_owner(owner: &str) -> u32 {
    FACES.with(|faces| faces.borrow_mut().release_owner(owner))
}

/// Frees every face.
#[wasm_bindgen]
pub fn face_release_all() {
    FACES.with(|faces| faces.borrow_mut().release_all());
}

/// True when a face is held under `alias`.
#[wasm_bindgen]
pub fn face_has(alias: &str) -> bool {
    FACES.with(|faces| faces.borrow().has(alias))
}

/// The owner of the face under `alias`, or `undefined` when none is held.
#[wasm_bindgen]
pub fn face_owner(alias: &str) -> Option<String> {
    FACES.with(|faces| faces.borrow().owner(alias).map(str::to_string))
}

/// The number of faces held.
#[wasm_bindgen]
pub fn faces_count() -> u32 {
    FACES.with(|faces| u32::try_from(faces.borrow().count()).unwrap_or(u32::MAX))
}

/// The bytes the faces hold, apart from the module's own memory.
#[wasm_bindgen]
pub fn faces_bytes_held() -> u32 {
    FACES.with(|faces| u32::try_from(faces.borrow().bytes_held()).unwrap_or(u32::MAX))
}

/// The font epoch: how many faces have been loaded in this instance.
#[wasm_bindgen]
pub fn font_epoch() -> u32 {
    FACES.with(|faces| faces.borrow().epoch())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_the_crate_version_and_the_interface_version() {
        assert_eq!(kernel_version(), env!("CARGO_PKG_VERSION"));
        assert_eq!(abi_version(), 2);
    }

    #[test]
    fn checksum_matches_the_published_fnv_1a_values() {
        // The test vectors of the FNV reference (32-bit FNV-1a).
        assert_eq!(checksum(b""), 0x811c_9dc5);
        assert_eq!(checksum(b"a"), 0xe40c_292c);
        assert_eq!(checksum(b"foobar"), 0xbf9c_f968);
    }

    #[test]
    fn checksum_depends_on_every_byte_and_on_their_order() {
        assert_ne!(checksum(b"ab"), checksum(b"ba"));
        assert_ne!(checksum(b"abc"), checksum(b"abd"));
    }
}
