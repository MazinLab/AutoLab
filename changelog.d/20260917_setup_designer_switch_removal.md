### Setup designer: removing switches and chains

- Removing a switch now reverses adding one: the selected branch folds back onto its chain in signal order and the chain gets its feedline letter back, instead of every branch and its parts vanishing and the chain being left unlabeled.
- Fibers pointing at a feedline that disappears (chain removed, switch removed, feedline renamed) follow the rename or move to the first remaining feedline, so a layout can no longer end up unsaveable with "optical part points at unknown feedline".
