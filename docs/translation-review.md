# Translation review status

All non-English translations are currently **unreviewed**, including existing
wording and machine-generated additions. They are enabled in the application
while language review is pending. Review status does not gate locale loading.
This applies to Lithuanian, Polish, Belarusian, Russian, Ukrainian, Latvian,
Estonian, Swedish, Norwegian Bokmål and Finnish, across the base, privacy,
setup and presentation namespaces.

## Review workflow

Use the separate offline PTN translation review tool (`ptn-translation-review`)
to collect verdicts, suggestions and notes. Start sessions without existing
review records so every phrase begins unreviewed. Its folder import accepts
`packages/frontend/src/i18n/locales/`; its `prepare-bundle.mjs` helper can
prepare the same base strings with inferred source references and vocabulary.

For each overlay namespace, import a prepared bundle with this shape:

```json
{
  "language": "lt",
  "source": {"privacy.level.baseline.name": "Baseline"},
  "translations": {"privacy.level.baseline.name": "Pradinis"}
}
```

Use the full English map from `src/i18n/<namespace>.json` as `source` and the
matching map from `src/i18n/<namespace>.<locale>.json` as `translations`.
Review the exact English and translated text together. Keep downloaded review
records in the review workflow; apply accepted wording changes through later
translation PRs. Changed text must be reviewed again.

Glossary terms marked `confirmed` describe dictionary metadata; that label does
not establish that any current phrase has been reviewed. Automated key parity,
placeholder checks and round-trip samples also do not establish language
approval.

## Runtime behavior

The application loads locale files and namespace overlays normally, including
unreviewed wording. Missing base strings use the existing English fallback
manifest. A successful overlay translation identical to English stays explicit
in its locale file. No translation-review UI or approval requirement is added
to the application.
