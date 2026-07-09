-- Skill-node <-> task links: the explicit "these two are the same work" edge that
-- spillover reads. Title similarity cannot find these pairs (a skill node is phrased
-- as a capability, a task as an action), so the edge is LLM-proposed and user-confirmed.
-- Only `confirmed` rows drive a spillover move; `dismissed` rows suppress re-suggestion.
create table if not exists skill_task_links (
  id            uuid primary key default gen_random_uuid(),
  skill_node_id uuid not null references skill_nodes(id) on delete cascade,
  task_id       uuid not null references tasks(id) on delete cascade,
  status        text not null default 'suggested',  -- suggested | confirmed | dismissed
  rationale     text,                               -- the model's one-line why, shown verbatim
  created_at    timestamptz not null default now(),
  unique (skill_node_id, task_id)
);

create index if not exists skill_task_links_node_idx on skill_task_links(skill_node_id);
create index if not exists skill_task_links_task_idx on skill_task_links(task_id);

-- Ownership is checked on BOTH sides: the node (via goals) and the task (via entries),
-- so a link can never straddle two users' rows.
alter table skill_task_links enable row level security;
drop policy if exists skill_task_links_owner on skill_task_links;
create policy skill_task_links_owner on skill_task_links
  for all
  using (exists (select 1 from skill_nodes s join goals g on g.id = s.goal_id
                 where s.id = skill_task_links.skill_node_id and g.user_id = auth.uid())
     and exists (select 1 from tasks t join entries e on e.id = t.entry_id
                 where t.id = skill_task_links.task_id and e.user_id = auth.uid()))
  with check (exists (select 1 from skill_nodes s join goals g on g.id = s.goal_id
                      where s.id = skill_task_links.skill_node_id and g.user_id = auth.uid())
          and exists (select 1 from tasks t join entries e on e.id = t.entry_id
                      where t.id = skill_task_links.task_id and e.user_id = auth.uid()));
