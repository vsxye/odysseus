# Sample outputs

Generated with `python -m assistant --demo --offline` (deterministic offline mode, no API key).
Each block shows the stage used, the parsed QueryPlan, the retrieved products with scores and reasons, and the answer.
With `ANTHROPIC_API_KEY` set (and no `--offline`), the same retrieved context is sent to Claude instead.

| # | Stage | Query |
|---|---|---|
| 1 | 1 | Does the NovaBook Air have enough RAM for coding? |
| 2 | 1 | Which earbuds have the longest battery life? |
| 3 | 2 | I need wireless headphones under ₹10,000 with good battery life |
| 4 | 2 | What laptops do you have for students? |
| 5 | 3 | Which laptop is best for video editing under ₹70,000? |

```text
====================================================================================================
Q: Does the NovaBook Air have enough RAM for coding?
Stage 1 (starter catalog P01-P04 in prompt, no retrieval) | mode: offline | context: 4 products, ~448 prompt tokens
----------------------------------------------------------------------------------------------------
Parsed plan:
  intent            product_question
  use_case          coding
  pinned_ids        P01
  asked_attributes  ram
  keywords          novabook, air, ram, coding
  profile           ram=0.45, cpu=0.3, storage=0.1, battery=0.15

Ranking (reference only - stage 1 sends the whole starter catalog):
  #  id   name                     category         price  score  why
  1  P01  NovaBook Air 14          Laptop         ₹52,000  0.290  name match; 8GB RAM; Intel i5; 10hr battery; 512GB storage; matches: novabook, air, ram
  2  P02  NovaBook Pro 15          Laptop         ₹78,000  0.910  16GB RAM (best in set); Intel i7 (best in set); 8hr battery; 1TB storage (best in set); matches: novabook, ram, performance, professional
  3  P04  SoundCore Studio Pro     Headset         ₹8,200  0.090  50hr battery (best in set)
  4  P03  SoundCore X40            Earbuds         ₹3,500  0.047  30hr battery

Answer:
  The NovaBook Air 14 (₹52,000) has 8GB RAM, Intel i5, 512GB SSD, 10hr battery. For light coding —
  VS Code, Python/JavaScript, web development and coursework — 8GB RAM is enough. For heavier work
  (large IDEs like IntelliJ or Android Studio, Docker containers, VMs, many browser tabs) 16GB is
  noticeably better, and the RAM is the limit here. If you need 16GB, the closest option in our
  catalog is the NovaBook Pro 15 (₹78,000) with 16GB RAM, Intel i7 and RTX 3050 GPU.

====================================================================================================
Q: Which earbuds have the longest battery life?
Stage 1 (starter catalog P01-P04 in prompt, no retrieval) | mode: offline | context: 4 products, ~446 prompt tokens
----------------------------------------------------------------------------------------------------
Parsed plan:
  intent            superlative
  categories        Earbuds
  wants_battery     True
  sort_by           battery_hr (desc)
  asked_attributes  battery
  keywords          earbud, longest, battery, life
  profile           battery=1.0

Ranking (reference only - stage 1 sends the whole starter catalog):
  #  id   name                     category         price  score  why
  1  P03  SoundCore X40            Earbuds         ₹3,500  1.000  30hr battery; matches: earbud, battery

Answer:
  The earbuds with the longest battery life are the SoundCore X40 (₹3,500) with 30hr battery (ANC,
  IP54).

====================================================================================================
Q: I need wireless headphones under ₹10,000 with good battery life
Stage 2 (parse + hard filters + BM25) | mode: offline | context: 5 products, ~654 prompt tokens
----------------------------------------------------------------------------------------------------
Parsed plan:
  intent            search
  categories        Headset, Earbuds
  price_max         ₹10,000
  need_wireless     True
  wants_battery     True
  asked_attributes  battery
  keywords          wireless, headphone, battery, life
  profile           battery=1.0

Retrieved products (5 of 11 candidates after filters):
  #  id   name                     category         price  score  why
  1  P21  Zentra Voyage ANC        Headset         ₹9,499  0.867  60hr battery (best in set); ₹9,499 ≤ ₹10,000; wireless; matches: headphone, battery
  2  P04  SoundCore Studio Pro     Headset         ₹8,200  0.819  50hr battery; ₹8,200 ≤ ₹10,000; wireless; matches: wireless, headphone, battery
  3  P19  Arcwave Bass 300         Headset         ₹2,499  0.650  40hr battery; ₹2,499 ≤ ₹10,000; wireless; matches: wireless, headphone, battery
  4  P20  Lumio Calm 500           Headset         ₹6,499  0.600  45hr battery; ₹6,499 ≤ ₹10,000; wireless; matches: headphone, battery
  5  P03  SoundCore X40            Earbuds         ₹3,500  0.324  30hr battery; ₹3,500 ≤ ₹10,000; wireless; matches: wireless, battery

Answer:
  Here are our wireless headphones under ₹10,000, ranked by battery life and relevance: 1. Zentra
  Voyage ANC (₹9,499) — 60hr battery, ANC; 2. SoundCore Studio Pro (₹8,200) — 50hr battery, ANC;
  3. Arcwave Bass 300 (₹2,499) — 40hr battery; 4. Lumio Calm 500 (₹6,499) — 45hr battery, ANC; 5.
  SoundCore X40 (₹3,500) — 30hr battery, ANC. Top pick: the Zentra Voyage ANC (₹9,499), with the
  longest battery in this range (60hr battery).

====================================================================================================
Q: What laptops do you have for students?
Stage 2 (parse + hard filters + BM25) | mode: offline | context: 5 products, ~590 prompt tokens
----------------------------------------------------------------------------------------------------
Parsed plan:
  intent            browse
  categories        Laptop
  use_case          student
  keywords          laptop, student

Retrieved products (5 of 9 candidates after filters):
  #  id   name                     category         price  score  why
  1  P01  NovaBook Air 14          Laptop         ₹52,000  1.000  matches: laptop, study, light, everyday
  2  P08  Arcwave Campus 14        Laptop         ₹33,990  0.997  matches: laptop, student, affordable, featherweight
  3  P02  NovaBook Pro 15          Laptop         ₹78,000  0.212  matches: laptop
  4  P07  Lumio StreamBook 15      Laptop         ₹45,990  0.203  matches: laptop
  5  P09  Pixelon Blaze 15         Laptop         ₹89,990  0.203  matches: laptop

Answer:
  Here are the laptops that best match for students: 1. NovaBook Air 14 (₹52,000) — 8GB RAM, Intel
  i5, 512GB SSD, 10hr battery; 2. Arcwave Campus 14 (₹33,990) — 8GB RAM, AMD Ryzen 3, 256GB SSD,
  14hr battery, 1.2kg; 3. NovaBook Pro 15 (₹78,000) — 16GB RAM, Intel i7, 1TB SSD, RTX 3050, 8hr
  battery; 4. Lumio StreamBook 15 (₹45,990) — 8GB RAM, Intel i3, 256GB SSD, Full HD display, 9hr
  battery; 5. Pixelon Blaze 15 (₹89,990) — 16GB RAM, Intel i7, 1TB SSD, RTX 4060, 165Hz display,
  6hr battery. For students on a budget, the Arcwave Campus 14 (₹33,990) is the most affordable
  and also has the longest battery (14hr battery). Lightest: Arcwave Campus 14 (1.2kg).

====================================================================================================
Q: Which laptop is best for video editing under ₹70,000?
Stage 3 (full pipeline: filters + BM25 + use-case spec scoring) | mode: offline | context: 5 products, ~780 prompt tokens
----------------------------------------------------------------------------------------------------
Parsed plan:
  intent            recommend
  categories        Laptop
  price_max         ₹70,000
  use_case          video_editing
  keywords          laptop, video, editing
  profile           ram=0.35, gpu=0.35, storage=0.15, cpu=0.15

Retrieved products (5 of 5 candidates after filters):
  #  id   name                     category         price  score  why
  1  P05  Zentra Vision 15         Laptop         ₹68,990  1.000  16GB RAM (best in set); RTX 4050 GPU (best in set); 512GB storage (best in set); AMD Ryzen 7 (best in set); ₹68,990 ≤ ₹70,000; matches: laptop, editing, creator, rendering
  2  P06  Pixelon Slim 14          Laptop         ₹61,000  0.417  16GB RAM (best in set); integrated graphics; 512GB storage (best in set); Intel i5; ₹61,000 ≤ ₹70,000; matches: laptop
  3  P01  NovaBook Air 14          Laptop         ₹52,000  0.241  8GB RAM; integrated graphics; 512GB storage (best in set); Intel i5; ₹52,000 ≤ ₹70,000; matches: laptop
  4  P07  Lumio StreamBook 15      Laptop         ₹45,990  0.189  8GB RAM; integrated graphics; 256GB storage; Intel i3; ₹45,990 ≤ ₹70,000; matches: laptop, video
  5  P08  Arcwave Campus 14        Laptop         ₹33,990  0.095  8GB RAM; integrated graphics; 256GB storage; AMD Ryzen 3; ₹33,990 ≤ ₹70,000; matches: laptop
  excluded by budget: NovaBook Pro 15 (₹78,000 > ₹70,000 (over budget)); Pixelon Blaze 15 (₹89,990 > ₹70,000 (over budget)); Zentra Studio X 16 (₹1,24,990 > ₹70,000 (over budget))

Answer:
  Best pick for video editing under ₹70,000: Zentra Vision 15 (₹68,990) — 16GB RAM, RTX 4050 GPU,
  512GB storage, AMD Ryzen 7. It scores highest on our spec profile: for video editing the
  dedicated GPU accelerates rendering and exports, and the RAM keeps timeline scrubbing smooth.
  Runner-up: Pixelon Slim 14 (₹61,000) — 16GB RAM, integrated graphics, 512GB storage, Intel i5.
  It costs ₹7,990 less and has a longer battery (12hr vs 7hr), but has integrated graphics instead
  of RTX 4050. Excluded: NovaBook Pro 15 (₹78,000) and Pixelon Blaze 15 (₹89,990) are over budget.
```
