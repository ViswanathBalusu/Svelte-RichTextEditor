//! The layout kernel (ADR 0016, decision 2): a compute kernel behind the measurement interface of
//! the layout engine (02 §9.1), compiled to WebAssembly and loaded on demand (WASM-002).
//!
//! WASM-001 is the toolchain, so this crate holds three calls that prove the build and the package
//! end to end, and nothing else. The kernel reads no file, no clock and no system font: every input
//! is a byte slice or a number given by the caller (WASM-005 brings fonts from the manifest).
//!
//! The crate forbids unsafe code. The glue that wasm-bindgen writes is not part of this crate.

#![forbid(unsafe_code)]

use wasm_bindgen::prelude::*;

/// The version of the call interface. It changes when a call of the kernel changes its meaning.
pub const ABI_VERSION: u32 = 1;

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_the_crate_version_and_the_interface_version() {
        assert_eq!(kernel_version(), env!("CARGO_PKG_VERSION"));
        assert_eq!(abi_version(), 1);
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
