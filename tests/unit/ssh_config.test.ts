import { describe, expect, test } from "bun:test";
import { filterNewHosts, parseSshConfigHosts } from "../../src/ssh_config.ts";

describe("ssh config host parsing", () => {
  test("parses basic host blocks with hostname and user", () => {
    const hosts = parseSshConfigHosts(`
Host dev
    HostName 192.168.1.20
    User deploy
    Port 2222
    IdentityFile ~/.ssh/id_ed25519

Host prod.example.com
    User root
`);
    expect(hosts).toEqual([
      { name: "dev", host: "192.168.1.20", username: "deploy" },
      { name: "prod.example.com", host: "prod.example.com", username: "root" },
    ]);
  });

  test("skips wildcard and negated patterns, keeps multiple aliases", () => {
    const hosts = parseSshConfigHosts(`
Host *.internal
    User admin

Host !blocked *.corp
    User root

Host web1 web2
    HostName 10.0.0.5
`);
    expect(hosts).toEqual([
      { name: "web1", host: "10.0.0.5" },
      { name: "web2", host: "10.0.0.5" },
    ]);
  });

  test("strips comments and is case-insensitive on keywords", () => {
    const hosts = parseSshConfigHosts(`
# full-line comment
host bastion # trailing comment
  hostname bastion.example.com
  USER ops
`);
    expect(hosts).toEqual([{ name: "bastion", host: "bastion.example.com", username: "ops" }]);
  });

  test("drops aliases the remotes API would reject", () => {
    const hosts = parseSshConfigHosts(`Host bad/name good-host\n`);
    expect(hosts).toEqual([{ name: "good-host", host: "good-host" }]);
  });

  test("empty and missing content yields nothing", () => {
    expect(parseSshConfigHosts("")).toEqual([]);
    expect(parseSshConfigHosts("# only a comment\n")).toEqual([]);
  });
});

describe("filterNewHosts", () => {
  const parsed = [
    { name: "dev", host: "192.168.1.20", username: "deploy" },
    { name: "dev2", host: "192.168.1.20", username: "deploy" },
    { name: "new", host: "10.1.1.1" },
  ];

  test("skips names already tracked", () => {
    const fresh = filterNewHosts(
      [{ name: "dev", host: "192.168.1.20", username: "deploy" }],
      parsed,
    );
    expect(fresh.map((h) => h.name)).toEqual(["new"]);
  });

  test("skips same host+user pair even under a different alias, dedups within config", () => {
    const fresh = filterNewHosts(
      [{ name: "other", host: "192.168.1.20", username: "deploy" }],
      parsed,
    );
    expect(fresh.map((h) => h.name)).toEqual(["new"]);
  });

  test("keeps everything when nothing is tracked", () => {
    const fresh = filterNewHosts([], parsed);
    // dev2 shares host+user with dev → deduped within the config itself.
    expect(fresh.map((h) => h.name)).toEqual(["dev", "new"]);
  });
});
