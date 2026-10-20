Agent monitor is one roster of every agent on a host, so you can see which ones need you without walking the workspace tree. It adds an **Agent monitor** sidebar screen and a Command Center item. Agents are grouped by project and workspace and sorted into Attention, Running, Idle and Closed, where Attention covers agents that need input, have errored, or have a pending permission request. The sidebar row also shows a count of agents needing attention.

Settings control grouping, sort order, density, which details each row shows, and the default filter. They are stored per host and shared by every connected client.

The header switches between the **Roster** and a **Graph** view. The graph lays agents out as a parent-child tree, draws message edges from timeline provenance, scales edge thickness by the number of messages exchanged, and labels each node with its project, workspace, branch and message count.

It reads agent, workspace and project lists through the selected host's existing connection and opens no connection of its own. The one action it performs is archiving, either a single agent or all closed agents. It cannot interrupt a running turn.

Requires Paseo ^0.12.0.
