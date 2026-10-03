# Projects as a container, and testbeds

Projects are now the top level container for a body of work. Wafers,
devices, experiment setups, experiments, and analyses pick their project
from a dropdown when created (required); designs, fab recipes, substrate
batches, and analysis software may pick one. Picking a wafer on the Device
form, a sample or setup on the Experiment form, or an experiment on the
Analysis form fills the project in for you; a project you chose yourself
is never overwritten, and the form says so when two references disagree.
Existing records stay unassigned until edited; the entity editor now has a
project dropdown (and a lead picker on projects).

A project page shows status, lead, a milestone progress bar, two
checklists (goals, and milestones with target dates and an overdue flag)
that can be added to, edited, reordered, checked off, and deleted inline,
the work in the project grouped by type with links into the filtered
browse lists, and recent activity. Projects lead the home page and the
Browse groups. Deleting a project that still contains work is refused.

Experimental instruments split into **Testbeds** (fridges, probe
stations; new template with base temperature and RF line counts) and
**Experimental Equipment**. Experiment setups now pick a testbed. Existing
fridges should be recategorized to `testbed` on their entity page.

New endpoints under `/api/project/{id}` (report and goal/milestone items)
and MCP tools `get_project_report`, `create_project_item`,
`update_project_item`. Schema migration `c4e8a1b7d203`.
