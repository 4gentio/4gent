CREATE TABLE `positions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`symbol` text NOT NULL,
	`asset_class` text NOT NULL,
	`quantity_raw` text DEFAULT '0' NOT NULL,
	`quantity` real DEFAULT 0 NOT NULL,
	`avg_entry_price` real DEFAULT 0 NOT NULL,
	`cost_basis` real DEFAULT 0 NOT NULL,
	`hard_stop_price` real DEFAULT 0 NOT NULL,
	`strategy` text DEFAULT 'unattributed' NOT NULL,
	`thesis` text DEFAULT '' NOT NULL,
	`invalidation` text DEFAULT '' NOT NULL,
	`time_horizon` text DEFAULT 'swing' NOT NULL,
	`conviction` integer DEFAULT 3 NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`opened_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`closed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `positions_open_symbol_idx` ON `positions` (`symbol`) WHERE `positions`.`status` = 'open';--> statement-breakpoint
CREATE INDEX `positions_status_idx` ON `positions` (`status`);--> statement-breakpoint
CREATE TABLE `trades` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`position_id` integer,
	`symbol` text NOT NULL,
	`side` text NOT NULL,
	`fill_price` real NOT NULL,
	`quantity` real NOT NULL,
	`quantity_raw` text NOT NULL,
	`notional` real NOT NULL,
	`fee_quote` real DEFAULT 0 NOT NULL,
	`gas_quote` real DEFAULT 0 NOT NULL,
	`slippage_bps` real DEFAULT 0 NOT NULL,
	`price_impact_bps` real DEFAULT 0 NOT NULL,
	`realized_pnl` real,
	`tx_hash` text,
	`mode` text NOT NULL,
	`strategy` text DEFAULT 'unattributed' NOT NULL,
	`reasoning_cycle_id` integer,
	`executed_at` integer NOT NULL,
	FOREIGN KEY (`position_id`) REFERENCES `positions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `trades_symbol_idx` ON `trades` (`symbol`);--> statement-breakpoint
CREATE INDEX `trades_executed_idx` ON `trades` (`executed_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `trades_tx_idx` ON `trades` (`tx_hash`) WHERE `trades`.`tx_hash` IS NOT NULL;--> statement-breakpoint
CREATE TABLE `candles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`symbol` text NOT NULL,
	`interval` text NOT NULL,
	`open_time` integer NOT NULL,
	`open` real NOT NULL,
	`high` real NOT NULL,
	`low` real NOT NULL,
	`close` real NOT NULL,
	`samples` integer DEFAULT 0 NOT NULL,
	`volume_quote` real DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `candles_bucket_idx` ON `candles` (`symbol`,`interval`,`open_time`);--> statement-breakpoint
CREATE INDEX `candles_lookup_idx` ON `candles` (`symbol`,`interval`,`open_time`);--> statement-breakpoint
CREATE TABLE `observations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`symbol` text NOT NULL,
	`price` real NOT NULL,
	`depth_usd` real DEFAULT 0 NOT NULL,
	`block_number` text NOT NULL,
	`source` text NOT NULL,
	`observed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `observations_symbol_time_idx` ON `observations` (`symbol`,`observed_at`);--> statement-breakpoint
CREATE TABLE `equity_quotes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ticker` text NOT NULL,
	`price` real NOT NULL,
	`provider` text NOT NULL,
	`quoted_at` integer NOT NULL,
	`fetched_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `equity_quotes_ticker_idx` ON `equity_quotes` (`ticker`,`fetched_at`);--> statement-breakpoint
CREATE TABLE `nav_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`nav` real NOT NULL,
	`cash` real NOT NULL,
	`positions_value` real NOT NULL,
	`unrealized_pnl` real NOT NULL,
	`realized_pnl_to_date` real NOT NULL,
	`recorded_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `nav_history_recorded_idx` ON `nav_history` (`recorded_at`);--> statement-breakpoint
CREATE TABLE `reasoning_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`model` text NOT NULL,
	`prompt_hash` text NOT NULL,
	`system_prompt` text NOT NULL,
	`snapshot` text NOT NULL,
	`raw_response` text NOT NULL,
	`parsed_decisions` text,
	`portfolio_note` text DEFAULT '',
	`actions_taken` text,
	`input_tokens` integer DEFAULT 0,
	`output_tokens` integer DEFAULT 0,
	`cached_tokens` integer DEFAULT 0,
	`latency_ms` integer DEFAULT 0,
	`validation_error` text,
	`started_at` integer NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
CREATE INDEX `reasoning_started_idx` ON `reasoning_log` (`started_at`);--> statement-breakpoint
CREATE TABLE `decision_outcomes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`reasoning_cycle_id` integer NOT NULL,
	`symbol` text NOT NULL,
	`action` text NOT NULL,
	`conviction` integer NOT NULL,
	`thesis` text NOT NULL,
	`invalidation` text NOT NULL,
	`entry_price` real,
	`exit_price` real,
	`pnl` real,
	`outcome` text DEFAULT 'open' NOT NULL,
	`rejection_reason` text,
	`created_at` integer NOT NULL,
	`resolved_at` integer
);
--> statement-breakpoint
CREATE INDEX `outcomes_created_idx` ON `decision_outcomes` (`created_at`);--> statement-breakpoint
CREATE TABLE `token_safety` (
	`address` text PRIMARY KEY NOT NULL,
	`symbol` text NOT NULL,
	`verdict` text NOT NULL,
	`risk_score` real DEFAULT 100 NOT NULL,
	`buy_tax_bps` real,
	`sell_tax_bps` real,
	`liquidity_usd` real,
	`holder_count` integer,
	`age_minutes` real,
	`source_verified` integer,
	`round_trip_ok` integer,
	`owner_privileges` text,
	`flags` text,
	`rationale` text DEFAULT '',
	`checked_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `token_safety_verdict_idx` ON `token_safety` (`verdict`);--> statement-breakpoint
CREATE TABLE `approvals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`token` text NOT NULL,
	`spender` text NOT NULL,
	`amount_raw` text NOT NULL,
	`tx_hash` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `approvals_pair_idx` ON `approvals` (`token`,`spender`);--> statement-breakpoint
CREATE TABLE `pending_txs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`nonce` integer NOT NULL,
	`tx_hash` text NOT NULL,
	`kind` text NOT NULL,
	`symbol` text,
	`payload` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`gas_price_wei` text,
	`attempts` integer DEFAULT 1 NOT NULL,
	`submitted_at` integer NOT NULL,
	`resolved_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pending_tx_hash_idx` ON `pending_txs` (`tx_hash`);--> statement-breakpoint
CREATE INDEX `pending_tx_nonce_idx` ON `pending_txs` (`nonce`);--> statement-breakpoint
CREATE TABLE `heartbeats` (
	`loop` text PRIMARY KEY NOT NULL,
	`last_run_at` integer NOT NULL,
	`last_success_at` integer NOT NULL,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`note` text
);
--> statement-breakpoint
CREATE TABLE `breakers` (
	`id` text PRIMARY KEY NOT NULL,
	`tripped` integer DEFAULT false NOT NULL,
	`reason` text,
	`peak_nav` real,
	`tripped_at` integer,
	`expires_at` integer
);
--> statement-breakpoint
CREATE TABLE `alert_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`level` text NOT NULL,
	`channel` text DEFAULT 'telegram' NOT NULL,
	`title` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`delivered` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `alert_log_created_idx` ON `alert_log` (`created_at`);--> statement-breakpoint
CREATE TABLE `kv` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
