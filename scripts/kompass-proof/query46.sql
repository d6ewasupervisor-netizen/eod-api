/*main org kompass compliance report bottom table*/
with visits as materialized  (
    select se.*
      from pcr_app.agg_scans_entity se
      join dds.d_store st on se.store_id = st.store_id and not st.is_test and not st.is_deleted
     where se.tag_id = 182 --and extract(year from se.scan_date) = 2026
       AND 'True' <> ''
       AND CASE WHEN CONCAT('701-Fred Meyer') = 'All' THEN st.group_level1 not in ('Atlanta', 'Delta', 'Nashville', 'Houston', 'Dallas', 'Ruler Food Stores', '011-Atlanta', '025-Delta','026-Nashville', '034-Houston', '035-Dallas', '090-Ruler Food Stores')
                ELSE st.group_level1 IN ('701-Fred Meyer') END
       AND CASE WHEN CONCAT('All') = 'All' THEN true ELSE st.group_level2 IN ('All') END
       AND CASE WHEN 0 in (0) THEN true ELSE se.store_id in (0) END
       and case when 0 in (0) then true else se.scan_category_id in (0) end
       and case when CONCAT('All') = 'All' then se.task_def_type in ('NII', 'UPDATE', 'MAINTENANCE')
                else se.task_def_type in ('All') end
       AND CASE WHEN -1 = -1 then true
           WHEN -1 = 1 then se.is_pl_exception > 0
           WHEN -1 = 0 then coalesce(se.is_pl_exception,0) = 0
       END
),
task_data as materialized  (
    select te.task_def_id,
           te.task_def_title task_name,
           te.task_def_type,
           te.task_id,
           te.scan_task_id,
           te.task_time,
           te.store_id,
           te.task_date,
           te.status,
           te.category_id,
           st.group_name,
           st.group_level2 district,
           st.store_name,
           te.status_reason,
           exc.exc_reason,
           te.performer_user_id,
           te.upl_time,
           te.pre_compliance,
           te.post_compliance,
           te.planogram_id,
           pip.planogram_name,
           te.bays_cnt,
           row_number() over (
                partition by te.store_id, te.task_def_id--, te.performer_user_id
                order by case when te.status = 'created' then 1 else 0 end, te.task_date desc
                ) as rn
      from pcr_app.agg_tasks_entity te
      join dds.d_planogram pip ON te.planogram_id = pip.planogram_id
      join dds.d_store st on te.store_id = st.store_id and not st.is_test and not st.is_deleted
      left join lateral ( select count(distinct pe.pog_exception_id)||' - '||string_agg(distinct pe.reason, ',') exc_reason
                            from pcr_app.agg_pog_exceptions pe
                            where pe.tag_id = 182
                             and coalesce(nullif(pe.reason,''), 'Custom') not in ('Custom')
                             and pe.store_id = te.store_id and pe.category_id = te.category_id and pe.task_id = te.task_id
                           limit 1
                ) exc on true
     where te.tag_id = 182 --and extract(year from te.task_date) = 2026
       AND 'True' <> ''
       and substr(te.task_def_title, 6, 1) = '-'
       AND CASE WHEN CONCAT('701-Fred Meyer') = 'All' THEN st.group_level1 not in ('Atlanta', 'Delta', 'Nashville', 'Houston', 'Dallas', 'Ruler Food Stores', '011-Atlanta', '025-Delta','026-Nashville', '034-Houston', '035-Dallas', '090-Ruler Food Stores')
                ELSE st.group_level1 IN ('701-Fred Meyer') END
       AND CASE WHEN CONCAT('All') = 'All' THEN true    ELSE st.group_level2 IN ('All') END
       AND CASE WHEN 0 in (0) THEN true ELSE te.store_id in (0) END
       and case when 0 in (0) then true else te.category_id in (0) end
       and case when CONCAT('All') = 'All' then te.task_def_type in ('NII', 'UPDATE', 'MAINTENANCE')
                else te.task_def_type in ('All') end
       and case when -1 = -1 then true
                when -1 = 1 then exc_reason is not null
                when -1 = 0 then exc_reason is null end
),
main as (
    select --pcs.id,
           td.pre_compliance,
           td.post_compliance,
           fsp.post_oos,
           task_name,
           td.task_def_type task_type,
           du.full_name user_name,
           cat.category_id,
           td.store_id,
           td.group_name,
           td.district,
           td.store_name,
           td.task_date,
           fsp.scan_date,
           td.planogram_id,
           td.planogram_name,
           cat.category_plangoram commodity,
           td.exc_reason,
           case when coalesce(nullif(tdsc.status,''), 'active') <> 'cancelled' then td.status
                  else coalesce(nullif(tdsc.status,''), 'active')
              end task_status,
           td.status_reason,
           fsp.pog_all_items,
           fsp.post_oos_new new_post_oos,
           fsp.pog_add_items new_pog_items,
           td.bays_cnt,
          --  to_char(td.start_time, 'HH24:mi') start_time,
           sum(all_prod) all_prod,
           sum(fsp.section_cnt) section_cnt,
           sum(action_ok) action_ok,
           sum(fsp.recommended_actions) recommended_actions,
           sum(fsp.executed_actions) executed_actions,
           sum(tag_present) tag_present,
           sum(corrected) corrected,
           sum(identified) identified,
           sum(no_response) no_response,
           sum(wandering) wandering,
           sum(invader) invader,
           sum(prod_dodnt_ship) prod_dodnt_ship,
           sum(warehouse) warehouse,
           sum(rep_couldnot_locate) rep_couldnot_locate,
          --  sum(unresolved_scan) unresolved_scan,
          --  sum(PLUNF) PLUNF,
           sum(Identify) Identify,
           sum(Remove) Remove,
           sum(action_move) action_move,
           sum(Pre_action) Pre_action,
           sum(Restock_after) Restock_after,
           td.task_time,
          --  ss.client_platform_code,
          --  ss.client_platform_version,
           upl_time,
           array_to_string(tdsc.confirmation_ids, ',') as req_ids
      from task_data td
      left join dds.d_category cat on td.category_id = cat.category_id
      left join dds.d_user du on du.user_id = td.performer_user_id
      left join visits fsp on
                            fsp.scan_date = td.task_date
                            and td.store_id = fsp.store_id
                            and td.category_id = fsp.scan_category_id
                            and td.task_def_id = fsp.task_def_id
      -- removed tasks that are not connected to the store
       left join tasks_taskdefstoreconfirmation tdsc on tdsc.store_id = td.store_id and tdsc.task_def_id = td.task_def_id
     --  join tasks_taskdefstore tt on tt.store_id = tdsc.store_id and tt.task_def_id = tdsc.task_def_id
     where 1=1
       and rn = 1
  /*     and case when CONCAT('All') = 'All' then true
                when ('All') = 'Completed' then td.status = 'completed'
                when ('All') = 'Not Completed' then td.status in ('incomplete', 'in_progress')
                when ('All') = 'Not Started' then td.status = 'created'
                when ('All') = 'Cancelled' then coalesce(nullif(tdsc.status,''), 'active') = 'cancelled' end*/
     group by 1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,
           td.task_time, /*ss.client_platform_code, ss.client_platform_version,*/ upl_time, 45
),
dat as (
    select group_name                                        as "Division",
           district                                          as "Supervisor",
           store_name                                        as "Store",
           task_name                                         as "Task Name",
           task_type                                         as "Task Type",
           case when task_status='incomplete' /*and coalesce(status_reason, '') != 'Not an Executable KOMPASS Event'*/ then 'Not Completed'
                when task_status='in_progress' /*and coalesce(status_reason, '') != 'Not an Executable KOMPASS Event'*/ then 'In Progress'
                when task_status='created' then 'Not Started'
                when task_status='completed' then 'Completed'
                when task_status='cancelled' then 'Cancelled'
           end as "Task Status",
           user_name                                         as "User Name",
           case when scan_date is null
                     then case when status_reason is not null or task_status = 'completed' then to_char(task_date, 'yyyy-mm-dd') end
                else to_char(scan_date, 'yyyy-mm-dd') end    as "Visit Date",
          --  start_time as "Start Time",
           status_reason                                     as "Task Exception Response",
          --  case when sum(unresolved_scan) > 0 then sum(unresolved_scan)
          --   end as "Unresolved AI",
           exc_reason                                        as "Planogram Exceptions",
           avg(pre_compliance)                               AS "PRE Compliance",
           bays_cnt                                          as "Bays",
          -- sum(section_cnt)                                  as "Bays",
           avg(post_compliance)                              as "POST Compliance",
           case when sum(pog_all_items)=0 then null
                when sum(pog_all_items) < sum(post_oos) then 0
                else 1 - sum(post_oos)::float / sum(pog_all_items) end "On Shelf Availability",
           case when sum(new_pog_items)=0 then null
                when sum(new_pog_items) < sum(new_post_oos) then 0
                else 1 - sum(new_post_oos)::float / sum(new_pog_items) end "New Item OSA %",
           sum(Identify)                                       as "Identify",
           sum(Remove)                                         as "Remove",
           sum(action_move)                                    as "Move",
           task_time                                           as "Task Time (m)",
          --  client_platform_code                              as "Platform",
          --  client_platform_version                           as "App version",
           ABS(extract(epoch from upl_time))                     as "Avg Upload Time (s)",
           commodity                                         as "Commodity",
           left(task_name, 5)::text as "Period/Week",
           req_ids "Req IDs",
           store_id, category_id, planogram_id, scan_date, sum(new_pog_items) new_pogs, sum(new_post_oos) new_post
      from main
     where case when concat('All') = 'All' then true
              else status_reason in ('All') end
       and case when CONCAT('All') = 'All' then true
                when CONCAT('All') like ('%incomplete%') then task_status in ('All','in_progress')
                else task_status in ('All')
            end
     group by 1,2,3,4,5,6,7,8,9,10, 12, 19,20,21,22,23,24,25,26,27
     order by 12 desc
),
reslt as (
    select "Division",
           "Supervisor",
           "Store",
           "Task Name",
           "Task Type",
           "Task Status",
           "User Name",
           "Visit Date",
          --  "Start Time",
           case when "Task Exception Response" is not null or
                    --  "Unresolved AI" > 0 or
                     "Planogram Exceptions" is not null or
                    -- "No Response" > 0 or
                    -- "Pre Actions" > 25 or
                     "PRE Compliance" <= 0.8 or
                     --"New Item OSA %" < 0.8 or
                     "On Shelf Availability" <= 0.1 or
                     "Task Status" = 'Not Started' then 1
                else 0 end "For Review",
           "Task Exception Response",
          --  "Unresolved AI",
           "Planogram Exceptions",
           "PRE Compliance",
           "Bays",
           "POST Compliance",
           "On Shelf Availability",
           "New Item OSA %",
           "Identify",
           "Remove",
           "Move",
           "Task Time (m)",
          --  "Platform",
          --  "App version",
           "Avg Upload Time (s)",
           "Commodity",
           "Period/Week",
           'details' as "Surveys",
           "Req IDs",
           store_id, category_id, planogram_id, "Visit Date" as v_date, new_pogs, new_post
      from dat
)
select *
  from reslt
 where case when -1 = -1 then true
            when -1 = 1 then "For Review" = 1
            when -1 = 0 then "For Review" = 0 end;