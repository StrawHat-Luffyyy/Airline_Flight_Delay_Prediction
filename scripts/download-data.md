# Downloading the dataset

The project uses the Kaggle dataset **"2015 Flight Delays and Cancellations"** (US DOT / BTS On-Time Performance data). The download is manual: the project assumes no Kaggle API key.

1. Sign in to Kaggle and open the dataset page: <https://www.kaggle.com/datasets/usdot/flight-delays>.
2. Click **Download** and unzip the archive.
3. Copy these three files into `data/raw/` at the repository root (the folder is git-ignored):

   ```
   data/raw/flights.csv    # ~5.8M rows, ~565 MB
   data/raw/airlines.csv
   data/raw/airports.csv
   ```

4. Start MongoDB and load the data:

   ```sh
   docker compose up -d mongo
   npm run ingest            # first load; refuses if flights already has data
   npm run ingest -- --drop  # rebuild from scratch
   ```

`npm run ingest` streams `flights.csv` in batches of 10,000 and never loads the whole file into memory. Each run writes a summary to the `ingest_runs` collection: rows read, inserted and rejected, with reject reasons and peak memory. Other flags: `--append` adds to existing data, `--limit N` stops after N flight rows, and `--dir PATH` reads the CSVs from another folder.
