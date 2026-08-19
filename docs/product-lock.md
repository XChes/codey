# Product Lock: Multi-Agent Desktop Coding App

## Outcome

- User: A developer working across one or more local project folders or Git repositories.
- Job and current pain: Organize coding conversations by project, choose direct shared work or isolated parallel worktrees, inspect agent work, control file changes, and publish Git-backed work without juggling terminals and worktrees manually.
- Trigger: Add any readable local project folder, or select an empty local directory and choose a repository from the authenticated GitHub account.
- Completed result: Local conversations update the shared project directly; Worktree conversations produce a reviewable isolated diff that can be merged locally or pushed as a ready-for-review GitHub pull request.
- Demo success: A project remains visible before it has any conversations; two conversations created within it run concurrently in isolated worktrees; a lead delegates to the built-in coding subagent; the user inspects conversations and accepts or rejects files; one conversation is merged or published as a pull request.
- Smallest useful cut: Persistent local and GitHub projects, project-grouped isolated conversation sessions, autonomous subagents, inspectable conversations, continuous whole-file review, and merge or pull-request delivery.



## Quality priority

- Priority: Orchestration reliability and polished conversation/diff UX are both hard requirements.
- Minimum bar: Parallel conversations never leak changes across worktrees, and the user can clearly inspect every agent and control every changed file before merging or publishing.



## Primary flow

1. Add any readable local project folder, or choose an empty directory and clone a selected public or private GitHub repository using the authenticated `gh` CLI account. The project remains in the sidebar even before its first conversation.
2. Select the project and choose Local or Worktree plus Ask for approval, Approve for me, or Full access for each new conversation; Local and Full are the defaults. Use the composer `+` menu to switch the conversation between Agent and Plan. Local uses the shared project directory and runs exclusively; Worktree is available when the project is a non-bare Git repository with a commit and may run in parallel with other Worktree conversations.
3. Each lead agent uses its `task` tool to assign the built-in generic coding subagent. A delegation chooses read capability for parallel analysis or write capability for foreground coding. Optional repository profiles may specialize that same mechanism. Their activity is selectable inside the conversation; the sidebar remains Project → Conversation.
4. While an agent is responding, submit adds a follow-up to Pi's native queue. Pending messages stack above the composer and may be promoted to steering; Restore queued moves the entire queue back to the composer, while Stop restores it and aborts the response.
5. For multi-step work, the agent creates and maintains one goal-scoped todo card. The user can add, rename, delete, dismiss, or change item status directly; an edit steers a running agent but never starts an idle one. Resolved lists archive on the next user prompt, and actionable lists archive after one primary turn without a todo update.
6. Review diffs continuously. Agent changes are live and accepted by default. Accept File establishes the current content as the new rejection baseline; Reject File restores the most recently accepted version. Later edits create a new reviewable diff.
7. Finish by either performing a normal Git merge into main or pushing the conversation branch and immediately creating a ready-for-review pull request with an agent-generated title and description. A merge conflict pauses for the user to resolve manually or delegate resolution to an agent.



## Core capabilities


| Capability                      | User-visible behavior                                                                                                                                                         | Acceptance evidence                                                                                                                                                     | Boundary                                                                                          |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Project onboarding              | Add any readable local folder as a persistent project or select and clone a GitHub repository into an empty local directory.                                                  | A selected project appears before its first conversation and remains available after restart.                                                                           | The app never silently initializes Git or commits local files; GitHub authentication reuses `gh`. |
| Project conversation navigation | View conversations grouped beneath their project, open the latest conversation by selecting a project, and create another conversation without choosing the repository again. | Conversations appear only beneath their project and every new conversation uses that project's repository.                                                              | The sidebar has Project → Conversation only; agents are inspected within a conversation.          |
| Parallel conversation isolation | Choose shared Local execution or an isolated Worktree for each conversation.                                                                                                  | Local sibling runs cannot overlap; two Worktree conversations run concurrently without cross-worktree file changes.                                                     | Worktree requires a non-bare Git repository with a usable `HEAD`; local macOS execution only.     |
| Conversation access control     | Choose Ask for approval, Approve for me, or Full access per conversation and change it between runs.                                                                          | Full is the default; the selected mode persists; external-path approvals transparently replace/reopen the worker and last only for the current run.                       | Protected paths, app data, Git metadata, local services, sockets, Apple Events, and PTY remain blocked in every mode. |
| Persistent Plan mode            | Choose Plan from the composer `+` menu to inspect the project and maintain a pending implementation plan in the conversation todo card; choose Agent to execute later.         | The selected interaction mode survives reopen and restart; Plan exposes only read, find, grep, ls, `request_access`, and `todo_write`, and never starts todo continuations. | New conversations default to Agent; mode changes are idle-only; Plan's SRT profile is OS read-only. |
| Autonomous subagents            | A lead creates and assigns a generic coding subagent without configuration; optional repository profiles add specialized instructions.                                       | A lead delegates read or write coding work and receives the result.                                                                                                    | No in-app subagent editor in the MVP.                                                             |
| Agent conversation              | Open a conversation and inspect its lead agent or subagent messages, reasoning, tool calls, and status.                                                                       | Assistant messages are expanded; reasoning and tool calls are collapsed by default and individually expandable.                                                         | No arbitrary branch browser, conversation rewind, or message edit.                                |
| Queue and steer                 | Queue a follow-up by default during a response, promote a pending row to steering, or restore all pending text to the composer.                                              | Pi queue events drive the stack; row Steer rebuilds the native queue while preserving other rows; delivered messages enter activity once.                              | Pi owns the queue; restore is bulk-only, and Delete/Edit remain unsupported.                      |
| Conversation todos              | See the agent's current goal in a collapsed-by-default editable card pinned above the composer; add, rename, delete, dismiss, complete, reopen, or block items with a reason. | Active state survives reopen; resolved state archives on the next prompt; an untouched actionable list archives after one primary turn; direct edits update Pi JSONL.    | No drag reordering or time-based TTL; after three automatic continuations, unresolved work yields to the user. |
| Continuous file review          | Inspect current file diffs and accept or reject whole files at any time.                                                                                                      | Agent changes remain when no review action is taken; Accept File advances the rejection baseline; Reject File restores the last accepted content while other files remain unchanged. | Whole-file only; hunk-level review is later.                                                      |
| Local integration               | Merge a completed conversation branch into main using normal Git merge behavior.                                                                                              | A clean merge completes; a conflict pauses for manual or agent-assisted resolution.                                                                                     | No automatic conflict resolution without the user's choice.                                       |
| GitHub delivery                 | Push a conversation branch and immediately create a normal ready-for-review pull request.                                                                                     | The remote branch and pull request exist with an agent-generated title and description.                                                                                 | No preview or draft-PR step.                                                                      |




## Critical recovery

- Each conversation worktree isolates agent changes from main and other conversations.
- Local conversations deliberately share accumulated project files, and the project lock prevents overlapping sibling runs.
- Agent changes remain in the conversation execution root and are included in delivery unless the user explicitly rejects them.
- Reject File restores only that file to its most recently accepted baseline.
- Merge conflicts preserve the conflicting state and require the user to choose manual or agent-assisted resolution.
- Failure to push or create a pull request leaves the local conversation worktree and branch intact for retry.
- Restore queued clears Pi's entire native steering and follow-up queue and returns its text to the composer.
- Stop performs the same bulk queue restore before aborting the active response.
- Todo state is reconstructed from the active Pi JSONL branch. File review never rewinds conversation or todo history.
- Archiving appends a null todo state, so earlier snapshots remain in Pi JSONL while the obsolete live card disappears.
- Agent, delegation, dependency, and per-agent projection records survive restart. Work left queued or running by process loss becomes interrupted rather than silently resuming.
- Cancelling a conversation cascades to its active children and queued dependents.



## Delivery facts

- The project uses the bundled macOS Electron/React desktop-agent skeleton as implemented Phase 1.
- The implemented foundation includes typed preload and JSON-RPC boundaries, a Pi-backed model-neutral Agent Host, one SRT boundary per agent worker and its direct tool children, three access modes, correlated approvals and delegation, transparent run-scoped grant replacement, masked credentials, agent-keyed AG-UI events, persistent project selection, SQLite task/agent/delegation state, persistent Pi sessions, cascading cancellation, and automated interface tests.
- Provider keys are stored with Electron `safeStorage` backed by macOS Keychain; settings expose configured status but never return plaintext. Provider API egress is preallowed in every access mode, with masked sentinels substituted by SRT's TLS proxy.
- The macOS package includes a checksum-pinned `gh` executable and reuses the host's existing authenticated `gh` CLI session.
- The MVP targets macOS only.



## Domain constraints

- A project is one selected local folder or Git repository and may contain zero or more conversations.
- A top-level conversation has one immutable execution target: Local or Worktree.
- A conversation persists one access mode and new conversations default to Full. It may change only while idle, which recreates that conversation's sandboxed worker with a new immutable mode-derived profile.
- A conversation persists one interaction mode, Agent or Plan, and defaults to Agent. It may change only while idle, which recreates that conversation's worker with the matching tool set.
- Ask and Approve for me external-filesystem grants are run-scoped. Approval transparently replaces the worker, reopens its Pi session, continues the run, and recycles the worker afterward to remove the grant.
- Plan is enforced as OS read-only across the worker process tree. Full remains subject to permanent protected-path and local-service denials.
- Local uses the selected project directory; Worktree uses one isolated branch and app-managed Git worktree.
- Subagents within a conversation operate on that conversation's execution root.
- A workspace is the files visible to an agent; a sandbox is the process policy controlling how that agent may access those files and the network. Sharing an execution root never means sharing a process or sandbox.
- Every lead and subagent has a separate Agent Host supervisor, Pi worker, Pi session, and immutable SRT profile. A child inherits the conversation access mode and permanent denials; a `read` profile additionally receives an OS-read-only project policy.
- The lead is the only agent that can use `task`; subagents cannot recursively delegate in the MVP.
- Read-only children may run concurrently. Write-capable children run only as foreground delegations and hold the conversation's single-writer lease for their whole turn.
- `dependsOn` edges form a per-run DAG. A child starts only after all dependencies complete successfully; otherwise it becomes blocked.
- Active-run background children keep the parent run open and deliver terminal results through a hidden correlated completion message. Detached tasks that outlive the parent run remain later scope.
- Agent file changes take effect inside the execution root before review and are accepted by default.
- Git initialization and the first commit remain explicit user actions. A later capability probe enables Worktree for new conversations.
- Accept File advances the per-file rejection baseline; Reject File restores it.
- GitHub cloning requires an empty destination directory.
- Pull requests are created immediately as ready for review.
- Steering and queued follow-ups share the active run and do not create filesystem recovery points.
- Pending native queue items are in-memory Pi state and are not recoverable after process loss.
- A conversation has at most one active, goal-scoped todo list. Pi JSONL is authoritative; SQLite stores only the latest read projection.
- Every `todo_write` or direct edit is a relevance heartbeat. A resolved list archives before the next user prompt; an actionable list archives when a primary turn leaves its revision unchanged.
- In Agent mode, todo completion means every item is completed or explicitly blocked with a reason, and the host attempts at most three automatic continuation turns before asking the user. Plan mode deliberately leaves proposed items pending and never starts those continuations.



## Acceptance boundary

- Agent-checkable evidence: automated interface tests, Local target/concurrency tests, Plan-mode persistence/tool-restriction tests, todo persistence/enforcement tests, parallel worktree isolation tests, subagent orchestration tests, default-accepted changes and file Accept/Reject tests, Git merge tests, and mocked plus authenticated happy-path `gh` integration checks.
- Owner product/UI acceptance: Project → Conversation sidebar hierarchy, conversation readability, collapsed reasoning/tool-call behavior, diff-review polish, and the complete desktop demo flow.



## Later

- Hunk-level Accept and Reject.
- In-app subagent configuration.
- Cloud agents running in sandboxes.
- Detached background tasks that outlive their parent run.
- Skill 
- Goal mode



## Excluded

- Project-wide checkpoint rewind.
- Arbitrary conversation branch browsing.
- App-managed GitHub authentication.



## Open owner decisions

- None.



## Owner status: Approved
