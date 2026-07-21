-- Append-only survey submissions: submitted rows stay forever; retake opens a new draft.
-- Also refresh Q42 wording (safety concerns).

ALTER TABLE survey_responses
  DROP CONSTRAINT IF EXISTS survey_responses_question_set_id_store_num_respondent_key;

-- At most one in-progress draft per person per store (per question set).
CREATE UNIQUE INDEX IF NOT EXISTS survey_responses_one_draft_per_person_store
  ON survey_responses (question_set_id, store_num, respondent)
  WHERE status = 'draft';

CREATE INDEX IF NOT EXISTS idx_survey_responses_store_submitted
  ON survey_responses (store_num, submitted_at DESC)
  WHERE status = 'submitted';

CREATE INDEX IF NOT EXISTS idx_survey_responses_respondent_store
  ON survey_responses (respondent, store_num, updated_at DESC);

UPDATE survey_question_sets
   SET spec = replace(
         spec::text,
         'Are there any safety issues or consistent issues with anything or anyone at {{storeName}}?',
         'Are there any safety concerns or consistent issues with anything or anyone at {{storeName}}?'
       )::jsonb
 WHERE version = 2;
