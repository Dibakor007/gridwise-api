# GridWise Project Architecture & Workflow

## Project Structure

The GridWise project is a full-stack application composed of a React frontend and a Node.js/Express backend. It is designed to interpret natural language energy operation notes using the Gemini API, and then mathematically optimize a 24-hour smart campus energy schedule using Linear Programming.

```text
/
├── server.ts                 # Production Express server entry point.
├── vite.config.ts            # Vite configuration (includes an interceptor to serve the API during dev).
├── package.json              # Project dependencies and npm scripts.
├── .env                      # Environment variables (e.g., GEMINI_API_KEY).
├── tsconfig.json             # TypeScript configuration for the React frontend.
├── src/
│   ├── main.tsx              # React application mount point.
│   ├── App.tsx               # Main React SPA (Single Page Application) dashboard UI.
│   ├── index.css             # Tailwind CSS v4 styling configuration.
│   └── server/               # Backend Core Logic (shared by dev plugin and prod server)
│       ├── handler.ts        # Express/API route handlers (`/health`, `/optimize-energy`).
│       ├── llm-interpreter.ts# Connects to Gemini to convert natural language to structured rules.
│       ├── optimizer.ts      # Linear Programming logic to schedule battery charging/discharging.
│       ├── types.ts          # Request/Response validation schemas and TypeScript definitions.
│       └── sampleCases.ts    # Seed data containing sample energy optimization challenges.
```

## Application Workflow

### 1. The Frontend UI (React + Tailwind)
The user interacts with the application via a sleek React dashboard (`App.tsx`). They can select predefined sample scenarios or use a Custom JSON mode to provide a specific 24-hour profile of campus energy demand, solar generation, grid tariffs, battery specifications, and natural language "operator notes." 

### 2. The API Request (Dev vs. Prod)
When the user clicks "Run Optimization", the frontend sends a `POST` request to the `/optimize-energy` endpoint.
- **In Development (`npm run dev`)**: The Vite development server uses a custom plugin (`vite.config.ts`) to intercept `/optimize-energy` API requests and process them natively.
- **In Production (`npm start`)**: The standalone `server.ts` Express application handles the routes and serves the built static frontend files.

### 3. LLM Interpretation (Gemini)
The backend route handler passes the natural language `operator_notes` to `llm-interpreter.ts`. This module communicates with the Gemini API to intelligently parse unstructured notes (e.g., "Do not charge the battery between 2 PM and 4 PM") into strictly formatted, deterministic directives (e.g., `no_charge_window: [14, 15]`).

### 4. Mathematical Optimization (Linear Programming)
The extracted directives, along with the raw 24-hour scenario data, are passed to `optimizer.ts`. This module defines a Linear Programming (LP) problem that mathematically guarantees the lowest possible grid electricity cost across the 24-hour period. It optimally schedules when the battery should charge from the grid/solar, when it should discharge to offset peak demand, and strictly obeys the LLM-extracted rules (e.g., enforcing minimum reserve levels or preventing charging during specific windows).

### 5. Visualization
The optimized 24-hour schedule is returned to the frontend as JSON. The React application parses this plan to populate KPIs (Total Cost, Peak Grid Load) and renders a visual, color-coded timeline breaking down the energy flow for every hour of the day.
