import type { Config } from "../config/env";
import { VERSION } from "../version";

// Update notices: which api and dashboard versions run, the newest releases on GitHub, the changelog in
// between and the steps to update. Releases are public data, so one cache per process is fine (nothing
// per user lives here); every replica asks GitHub at most once per UPDATE_CHECK_INTERVAL_MS.

export type Component = "api" | "dashboard";
export interface Release { version: string; name: string | null; notes: string | null; url: string | null; publishedAt: Date | null }
export interface ComponentUpdate { component: Component; current: string | null; latest: string | null; updateAvailable: boolean; image: string; changes: Release[] }
export interface SystemUpdates {
  enabled: boolean;
  checkedAt: Date | null;
  error: string | null;
  updateAvailable: boolean;
  docsUrl: string;
  steps: string[];
  components: ComponentUpdate[];
}

/** "1.2.3" or "v1.2.3" (no pre-release: those never count as an update). */
const SEMVER = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/;
export const parseVersion = (v: string | null | undefined): [number, number, number] | null => {
  const m = v ? SEMVER.exec(v.trim()) : null;
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
}
const clean = (v: string) => v.trim().replace(/^v/, "");

interface GithubRelease { tag_name?: unknown; name?: unknown; body?: unknown; html_url?: unknown; published_at?: unknown; draft?: unknown; prerelease?: unknown }
const str = (v: unknown, max: number) => (typeof v === "string" && v ? v.slice(0, max) : null);

/** Published, non-pre-release releases with a semver tag, newest first. Everything from the feed is untrusted: typed and capped. */
export function toReleases(json: unknown): Release[] {
  if (!Array.isArray(json)) throw new Error("unexpected answer from the release feed");
  return (json as GithubRelease[])
    .filter((r) => r && !r.draft && !r.prerelease && typeof r.tag_name === "string" && parseVersion(r.tag_name))
    .map((r) => {
      const url = str(r.html_url, 500);
      const at = str(r.published_at, 40);
      return {
        version: clean(r.tag_name as string),
        name: str(r.name, 200),
        notes: str(r.body, 20_000),
        url: url && /^https:\/\//.test(url) ? url : null,
        publishedAt: at && !Number.isNaN(Date.parse(at)) ? new Date(at) : null,
      };
    })
    .sort((a, b) => compareVersions(b.version, a.version));
}

const DOCS_URL = "https://github.com/mgpl-diagnostics/api/blob/main/docs/19-updates.md";
const MIN_REFRESH_MS = 60_000;

export class SystemService {
  private cache: { at: Date; releases: Record<Component, Release[]> } | null = null;
  private error: string | null = null;
  private inflight: Promise<void> | null = null;
  private lastAttempt = 0;

  constructor(
    private readonly config: Config["updates"],
    private readonly fetchFn: typeof fetch = (...a) => fetch(...a),
    private readonly now: () => number = Date.now,
  ) {}

  /** The api's own version (package.json of this build). */
  get version(): string {
    return VERSION;
  }

  private async fetchReleases(repo: string): Promise<Release[]> {
    const res = await this.fetchFn(`${this.config.feedUrl}/repos/${repo}/releases?per_page=30`, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "mgpl-api-update-check",
        "x-github-api-version": "2022-11-28",
        ...(this.config.githubToken ? { authorization: `Bearer ${this.config.githubToken}` } : {}),
      },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error(res.status === 403 || res.status === 429 ? "GitHub rate limit reached; set UPDATE_GITHUB_TOKEN or try later" : `the release feed answered ${res.status}`);
    return toReleases(await res.json());
  }

  private async load(force: boolean): Promise<void> {
    const t = this.now();
    const fresh = this.cache && t - this.cache.at.getTime() < this.config.intervalMs;
    if (fresh && !force) return;
    // a failed check or a forced one waits at least a minute before the next
    if (t - this.lastAttempt < MIN_REFRESH_MS && (this.cache || this.error)) return;
    if (!this.inflight) {
      this.lastAttempt = t;
      this.inflight = (async () => {
        try {
          const [api, dashboard] = await Promise.all([this.fetchReleases(this.config.repos.api), this.fetchReleases(this.config.repos.dashboard)]);
          this.cache = { at: new Date(this.now()), releases: { api, dashboard } };
          this.error = null;
        } catch (e) {
          // keep the last good answer; the message is ours or a network error, never a token
          this.error = `Could not check for updates: ${e instanceof Error && e.name === "TimeoutError" ? "the release feed did not answer" : e instanceof Error ? e.message.slice(0, 200) : "unknown error"}`;
        } finally {
          this.inflight = null;
        }
      })();
    }
    await this.inflight;
  }

  private component(component: Component, current: string | null): ComponentUpdate {
    const releases = this.cache?.releases[component] ?? [];
    const latest = releases[0]?.version ?? null;
    const known = current !== null && parseVersion(current) !== null;
    const changes = known ? releases.filter((r) => compareVersions(r.version, current) > 0).slice(0, 20) : releases.slice(0, 1);
    return {
      component,
      current,
      latest,
      updateAvailable: known && latest !== null && compareVersions(latest, current) > 0,
      image: this.config.images[component],
      changes,
    };
  }

  /** Owners and admins: what runs, what's out, what changed, how to update. `dashboardVersion` comes from the dashboard build. */
  async updates(input: { dashboardVersion?: string | null; refresh?: boolean | null } = {}): Promise<SystemUpdates> {
    const dashboardVersion = input.dashboardVersion && parseVersion(input.dashboardVersion) ? clean(input.dashboardVersion) : null;
    if (this.config.enabled) await this.load(!!input.refresh);
    const components = [this.component("api", VERSION), this.component("dashboard", dashboardVersion)];
    const target = (c: ComponentUpdate) => c.latest ?? "latest";
    const [api, dash] = components as [ComponentUpdate, ComponentUpdate];
    return {
      enabled: this.config.enabled,
      checkedAt: this.cache?.at ?? null,
      error: this.config.enabled ? this.error : null,
      updateAvailable: components.some((c) => c.updateAvailable),
      docsUrl: DOCS_URL,
      steps: [
        "Back up the database (pg_dump, or your provider's snapshot) before every update.",
        "On the server, open the folder that holds docker-compose.yml and .env.",
        `In .env, set MGPL_API_VERSION=${target(api)} and MGPL_DASHBOARD_VERSION=${target(dash)} (or leave both on "latest").`,
        "docker compose pull",
        "docker compose up -d   (db-sync adds new tables first, then the api, worker and dashboard restart)",
        "docker compose ps   (every service up; the api shows healthy)",
      ],
      components,
    };
  }
}
