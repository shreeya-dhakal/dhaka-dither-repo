# Bundled fonts

Committed, not fetched. The tool must work fully offline, and glyph density
measurement has to be deterministic — measuring whatever the system happened to
substitute would produce a different tonal ladder on every machine.

| File | Family | Source |
|---|---|---|
| `noto-sans-devanagari-var.woff2` | Noto Sans Devanagari, variable `wght` 400–700 | Google Fonts, Devanagari subset (U+0900–097F and friends) |
| `ibm-plex-mono-400.woff2` | IBM Plex Mono 400 | Google Fonts, Latin subset (U+0000–00FF and friends) |
| `ibm-plex-mono-700.woff2` | IBM Plex Mono 700 | Google Fonts, Latin subset |
| `nithya-ranjana-du.otf` | Nithya Ranjana, Devanagari Unicode build | [Ek Type](https://github.com/EkType/Nithya-Ranjana) release 1.000 |

All three families are **SIL Open Font License 1.1**, compatible with this
project's MIT licence. OFL clause 2 requires that *each copy* of the font ship
with its copyright notice and licence — a link is not enough — so the full text
is committed beside each face:

- `OFL-NotoSansDevanagari.txt`
- `OFL-IBMPlexMono.txt`
- `OFL-NithyaRanjana.txt`

**Nithya Ranjana** is by [Ek Type](https://www.ektype.in), developed with
[Callijatra](https://www.callijatra.com). It is the reason the Ranjana feature
exists, and it is not on Google Fonts — the OTF comes from the project's own
release page.

The release also carries an `NU` build mapped to Newa Unicode. Only the `DU`
(Devanagari Unicode) build is bundled: Ranjana has no Unicode block of its own,
so the DU build reuses Devanagari codepoints. That mapping is an implementation
detail, never a UI concept.

The Noto and Plex files are the per-unicode-range subsets Google Fonts already
serves, so no local subsetting tool is involved. To refresh one, request the CSS
with a browser `User-Agent` (the API serves woff2 only to browsers), take the
`src` URL whose `unicode-range` covers the script you want, and download it.

Nithya Ranjana is the exception: it is not on Google Fonts, so it is the OTF from
Ek Type's own release, unsubsetted at 361 KB. Subsetting it locally would mean
adding a tool to a project that keeps its dependency list short on purpose.

The Devanagari face carries a variable weight axis, so step 7's flow mode gets a
real axis rather than the 400/700 fallback. IBM Plex Mono is not variable on
Google Fonts, which is exactly the "otherwise 400 vs 700" case the spec
anticipates.
