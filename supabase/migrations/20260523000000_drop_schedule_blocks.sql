-- The recommended schedule is now a derived view (computed on read from live
-- tasks + availability), no longer persisted. Drop the orphaned table; its
-- index and RLS policy go with it.
drop table if exists schedule_blocks;
