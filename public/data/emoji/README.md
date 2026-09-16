# Vidamia emoji metadata

Generated from **emojibase-data 17.0.0** (MIT, Miles Johnson) and Unicode's Emoji 17.0 `emoji-test.txt` (Unicode license). Emojibase derives labels, keyword tags and group ordering from Unicode CLDR. Both licenses are included alongside these modified/generated data files.

- Official documentation: https://emojibase.dev/docs/datasets/
- Package: https://registry.npmjs.org/emojibase-data/-/emojibase-data-17.0.0.tgz
- Package SHA256: `d01d0e2ca4e22cb402679532155342c71e2e871f25c32223c013b8b166ebdf5a`
- Unicode source: https://www.unicode.org/Public/17.0.0/emoji/emoji-test.txt
- Unicode SHA256: `1d8a944f88d7952f7ef7c5167fef3c67995bcae24543949710231b03a201acda`

Extract the package into a scratch directory and run:

```sh
node scripts/build-emoji-catalog.mjs path/to/package path/to/emoji-test.txt
```

The generator verifies the Unicode input checksum, checks the package version, removes standalone non-RGI components and verifies **all 3,944 fully qualified RGI sequences** are represented. The main grid has **1,914 base choices**, with **2,030 skin-tone variants** available through a secondary interaction. Stored sequences use Unicode's fully qualified form. Array fields in `catalog.js` are `[sequence, English CLDR label, group, order, tags, variants]`; a variant is `[sequence, label, order]`.

English labels/tags and 16 additional application locales (German, Spanish, French, Italian, Swedish, Russian, Chinese, Japanese, Hindi, Portuguese, Ukrainian, Polish, Dutch, Vietnamese, Hungarian and Korean) are bundled. Locales absent from this Emojibase release use English. English remains searchable alongside a supported local language. Dataset updates are explicit build-time maintenance, never a remote request from the picker.

Normal browsing/search uses the bundled metadata entirely on-device. The service worker precaches the files, and opening the picker loads only its base catalog and selected locale. It renders a bounded window of rows rather than thousands of buttons. The system emoji font renders glyphs: an older Android font may not display the newest Emoji 17 characters even though the data and stored sequences are complete. No emoji keyboard or third-party runtime CDN is used.
