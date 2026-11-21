# lauzhack-2026

Project for **LauzHack 2026**.

## Idea

Turn Swiss public-transport disruption data into something useful. The dataset
we work with comes from the VIA / Liveticker system: unplanned incidents
(strikes, track damage, vehicle problems, ...), the short ticker messages that
traffic control publishes for each of them, the standardised reason codes, and
an audit trail of every edit.

## Data

The exports live outside the repository (in `../Daten`) and are split into:

| Folder             | Contents                                                              |
|--------------------|-----------------------------------------------------------------------|
| `extern-liveticker`| PostgreSQL CSV exports: incidents, messages, reasons, audit tables      |
| `intern-liveticker`| One month of incident cases, categories, messages and change logs      |
| `Ereignismeldungen`| Spreadsheet of incident reports                                        |

Each folder has its own README describing the columns, plus a PlantUML ERD for
the schema. Text fields are usually available in `de`, `fr`, `it` and `en`;
`origin_language` marks the one written by a human.

## Getting started

```bash
git clone git@github.com:alicedidomenico01/lauzhack-2026.git
cd lauzhack-2026
```

Nothing to install yet — this README is the only artefact so far.

## Notes

- Keep large CSV exports out of git; put them in `Daten/` next to the repo.
- One branch per feature, PR into `main`.
