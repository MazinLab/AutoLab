Fixes from iPhone use in the lab:

- Photos and files picked on iPhone Safari now stick. The create form dropped every pick made after typing, and the record page kept only the first of two picks, because Safari empties the picked file list when the input resets. Affects the create form, the record page's attach control, and quick notes.
- The success card says "Label sent to zebra." when a wafer, substrate batch, or instrument auto-prints on create, so nobody prints a second one by hand.
- "Create another" after a fab step, wafer measurement, or note keeps the wafer, recipe, and instrument links but clears the title, log text, and results. For fab steps, the step index moves to the next number.
