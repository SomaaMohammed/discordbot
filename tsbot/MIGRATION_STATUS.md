# TypeScript Migration Status

## Command parity tracker

### court

- [x] status
- [x] health
- [x] analytics
- [x] dryrun
- [x] exportstate
- [x] importstate
- [x] mode
- [x] channel
- [x] logchannel
- [x] schedule
- [x] listcategories
- [x] addquestion
- [x] deletequestion
- [x] editquestion
- [x] resethistory
- [x] post
- [x] custom
- [x] close
- [x] listopen
- [x] extend
- [x] reopen
- [x] removeanswer

### questions

- [x] count
- [x] unused
- [x] audit

### invictus

- [x] say
- [x] rolepanel
- [x] rolepanelmulti
- [x] purge
- [x] purgeuser
- [x] lock
- [x] unlock
- [x] slowmode
- [x] timeout
- [x] untimeout
- [x] mutemany
- [x] unmutemany
- [x] muteall
- [x] unmuteall
- [x] backfillstats
- [x] backfillstatus
- [x] afk
- [x] afkstatus
- [x] resetroyaltimer
- [x] help

### fun

- [x] battle
- [x] stats
- [x] leaderboard
- [x] verdict
- [x] title
- [x] fate

### greetings

- [x] rio
- [x] taylor

## Non-command parity tracker

- [x] Runtime env loading and validation
- [x] SQLite schema bootstrap
- [x] JSON to DB migration bootstrap
- [x] State shape and merge sanitization helpers
- [x] Royal trigger and mention parsers
- [x] Role panel metadata parsers
- [x] Backfill status state helpers
- [x] Event handlers parity (`on_message`, `on_raw_reaction_add`)
- [x] Background loops parity (`auto_poster`, `thread_closer`, `weekly_digest`, `retention_cleaner`)
- [x] Anonymous answer modal and answer button parity
- [x] Role panel button claim interaction parity
- [x] Remaining modal and persistent view parity (`invictus say`)
- [x] Admin moderation parity
- [x] Full analytics parity

## Immediate next migration slices

1. Expand integration-style command tests for role panel posting and bulk moderation edge cases.
2. Add focused tests for modal submit flows (`anonymous answer` and `invictus say`) with permission/channel failure paths.
