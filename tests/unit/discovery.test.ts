import { describe, expect, test } from "bun:test";
import { parseWslDistroList } from "../../src/discovery.ts";

describe("parseWslDistroList", () => {
  test("parses plain ASCII output", () => {
    expect(parseWslDistroList("Ubuntu\r\nUbuntu-24.04\r\n")).toEqual(["Ubuntu", "Ubuntu-24.04"]);
  });

  test("parses UTF-16LE output that was mis-decoded as UTF-8", () => {
    const utf16 = Buffer.from("UbuntuRecover\r\ndocker-desktop\r\n", "utf16le").toString("utf8");
    expect(parseWslDistroList(utf16)).toEqual(["UbuntuRecover"]);
  });

  test("drops infrastructure distros and blank lines", () => {
    expect(parseWslDistroList("docker-desktop\ndocker-desktop-data\n\nUbuntu\n")).toEqual([
      "Ubuntu",
    ]);
  });

  test("rejects garbage lines instead of passing them to UNC paths", () => {
    expect(parseWslDistroList("Ubuntu\n!!!\nwith space\n")).toEqual(["Ubuntu"]);
  });
});
