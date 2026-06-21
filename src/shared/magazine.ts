/**
 * Shared magazine types (PLAN.md MG1). Imported by BOTH the Bun server and the
 * Vite web frontend so the wire shape is single-sourced.
 *
 * - `MagazineSpec` = what Codex returns (MG4): excerpts reference a `postId`; the
 *   server attaches canonical source URL/title from fetched data (provenance, R1-#11).
 * - `Magazine` = the assembled, server-owned object the frontend renders.
 */

/** What Codex emits per excerpt — references a post by id only (no model-supplied URLs). */
export interface SpecExcerpt {
  postId: string;
  text: string;
}

export interface SpecSection {
  heading: string;
  prose: string;
  excerpts: SpecExcerpt[];
}

export interface MagazineSpec {
  intro: string;
  themes: string[];
  sections: SpecSection[];
  vibePresetId: string;
  accentColor: string;
  imageQueries: string[];
}

/** Assembled excerpt — server attaches the canonical, trusted source link. */
export interface Excerpt {
  text: string;
  sourceUrl: string;
  sourceTitle: string;
}

export interface MagazineImage {
  /** Local relative path within the magazine's vault folder (offline-safe). */
  src: string;
  alt: string;
}

export interface MagazineSection {
  heading: string;
  prose: string;
  excerpts: Excerpt[];
  images: MagazineImage[];
}

export interface Magazine {
  id: string;
  newsletter: string;
  newsletterUrl: string;
  title: string;
  intro: string;
  themes: string[];
  vibePresetId: string;
  accentColor: string;
  sections: MagazineSection[];
  generatedAt: string;
}

/** Hardcoded stub returned by POST /surprise until MG2–MG7 are wired in. */
export const STUB_MAGAZINE: Magazine = {
  id: "stub-the-intrinsic-perspective",
  newsletter: "The Intrinsic Perspective",
  newsletterUrl: "https://www.theintrinsicperspective.com/",
  title: "A Field Guide to the Intrinsic Perspective",
  intro:
    "This is a stub magazine returned by the MG1 skeleton. Real content arrives once the pool, fetcher, Codex synthesis, and image pipeline (MG2–MG7) are built.",
  themes: ["consciousness", "neuroscience", "the science of the mind"],
  vibePresetId: "classic-editorial",
  accentColor: "#9c4a2f",
  sections: [
    {
      heading: "Why the inner view resists measurement",
      prose:
        "A recurring thread: subjective experience keeps slipping out of the instruments we build to catch it. The connective tissue here is written by Codex; the quotes below are real excerpts that link back to the source.",
      excerpts: [
        {
          text: "Consciousness is the one fact we cannot get behind.",
          sourceUrl: "https://www.theintrinsicperspective.com/p/example",
          sourceTitle: "The hard problem, revisited",
        },
      ],
      images: [],
    },
  ],
  generatedAt: "1970-01-01T00:00:00.000Z",
};
