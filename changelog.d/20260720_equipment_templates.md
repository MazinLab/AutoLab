# Equipment templates and machine/cooldown dropdowns (2026-07-20)

- New Experimental Equipment and Fab Equipment templates register instruments
  (common name, kind, location, manufacturer/model, serial or asset tag) with
  a new `category` column ("experimental" / "fab", Alembic migration
  b7e4c5d2a911) stamped invisibly by the template via a new `defaults`
  mechanism in the template JSON. Equipment auto-prints a QR label like other
  physical objects.
- Experiment logs gain Instrument (experimental equipment) and Cooldown
  dropdowns; Fab Step gains a Machine dropdown (fab equipment, linked
  `performed_on`). Run Setup, Cooldown, and Maintenance instrument search
  boxes became recent-first dropdowns, category-filtered where it makes
  sense. Uncategorized legacy instruments stay visible in every dropdown.
- Tc Test template removed — it is just a kind of experiment.
- Dropdown labels show the type suffix only for mixed-type pickers, and
  cooldowns with no name display their start date.
