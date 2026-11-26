import { describe, expect, it } from "vitest";
import { sha256Hex } from "./index.js";

// Expected values from `shasum -a 256`, not from this code.
describe("sha256Hex", () => {
  it("matches the standard vectors", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("hashes a string as UTF-8", () => {
    expect(sha256Hex("héllo ☃ 👍🏽")).toBe("8c6e85299f1efbbac66ecf66b2f37e5c901f5b0a9ec47b0d9b2470ccd13fa94e");
  });

  it("hashes bytes as given, never decoded", () => {
    expect(sha256Hex(new Uint8Array([0xff, 0xfe, 0x00, 0x80]))).toBe("5a741968f40e57485ed6e1a1af381adeb2714223c35acedf1ad0670e42df2eb5");
    expect(sha256Hex(Buffer.from("abc"))).toBe(sha256Hex("abc"));
  });

  it("keeps the first `length` characters when given", () => {
    expect(sha256Hex("abc", 16)).toBe("ba7816bf8f01cfea");
    expect(sha256Hex("abc", 32)).toBe("ba7816bf8f01cfea414140de5dae2223");
  });
});
