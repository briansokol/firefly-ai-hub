# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Purpose

This repository is for planning and building an AI Hub on this server. It serves as both a planning workspace and a codebase for any code that gets written.

## Repository Structure

- `plans/` — Planning documents for AI Hub components and features
- Any code written as part of the AI Hub lives in this repo alongside the plans

## Working Conventions

- Plans go in the `plans/` folder before implementation begins
- Keep plans and their corresponding code co-located or clearly cross-referenced

## Key Files

- `plans/tasks.md` — Active task list with current progress (checked = done)
- `plans/2026-02-27-ai-hub-architecture-design.md` — Full architecture plan and deployment order

## Session Continuity

- Use `/ai-hub-resume` at the start of any session to orient to current task list state
- Tasks use `- [x]` / `- [ ]` checkboxes; completed sections are marked with ✓ in the header
- User confirms completion of each task before moving to the next — don't skip ahead
