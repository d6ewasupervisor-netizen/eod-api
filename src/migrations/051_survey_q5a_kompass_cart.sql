-- Q5a: say "on the Kompass cart" instead of "on it"
UPDATE survey_question_sets
   SET spec = replace(
         spec::text,
         'Does {{storeName}} put new items on it?',
         'Does {{storeName}} put new items on the Kompass cart?'
       )::jsonb
 WHERE version = 2;
