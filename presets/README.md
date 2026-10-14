# Presets

Place exported Aviation Briefing saved-inputs JSON files in this folder, then add each file to `index.json`:

```json
{
  "presets": [
    { "name": "Nordic airports", "file": "nordic.json" }
  ]
}
```

Preset files use the same JSON format produced by **Settings → Export saved inputs**. Selecting one asks before merging its missing airports and groups into the current setup. Existing airports and groups are preserved; groups with the same name are merged.

After changing this catalog, increment `AVIATION_BRIEFING_VERSION` in `version.js` before publishing. The service worker caches the catalog and its listed files when it installs the new version, so installed apps also have the presets offline.
