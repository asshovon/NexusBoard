import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { createServer as createViteServer } from "vite";
import path from "path";
import fs from "fs";
import { v4 as uuidv4 } from "uuid";

// Types for the server
interface DrawElement {
  id: string;
  type: 'pencil' | 'rect' | 'circle' | 'text' | 'eraser';
  points?: number[];
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  radius?: number;
  text?: string;
  color: string;
  strokeWidth: number;
  creator: string;
}

interface Page {
  id: string;
  elements: DrawElement[];
}

interface Board {
  id: string;
  name: string;
  pages: Page[];
  thumbnail?: string;
}

interface Message {
  type: 'init' | 'draw' | 'clear' | 'cursor' | 'join' | 'sync_request' | 'add_page' | 'delete_page';
  boardId: string;
  payload?: any;
  sender?: string;
}

const DATA_FILE = path.join(process.cwd(), "boards_data.json");

// Load or initialize boards data
let boards: Record<string, Board> = {};
if (fs.existsSync(DATA_FILE)) {
  try {
    boards = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
    // Migration check: if boards were saved in old format, migrate them
    Object.values(boards).forEach(b => {
      if (!b.pages) {
        // @ts-ignore
        const oldElements = b.elements || [];
        b.pages = [{ id: uuidv4(), elements: oldElements }];
        // @ts-ignore
        delete b.elements;
      }
    });
  } catch (e) {
    boards = {};
  }
}

function saveBoards() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(boards, null, 2));
}

async function startServer() {
  const app = express();
  const server = createServer(app);
  const wss = new WebSocketServer({ server });
  const PORT = 3000;

  app.use(express.json());

  // API Routes
  app.get("/api/boards", (req, res) => {
    res.json(Object.values(boards).map(b => ({
      id: b.id,
      name: b.name,
      pageCount: b.pages.length,
      thumbnail: b.thumbnail
    })));
  });

  app.post("/api/boards", (req, res) => {
    const { name } = req.body;
    const id = uuidv4();
    boards[id] = { 
      id, 
      name, 
      pages: [{ id: uuidv4(), elements: [] }] 
    };
    saveBoards();
    res.json(boards[id]);
  });

  app.post("/api/boards/:id/thumbnail", (req, res) => {
    const { id } = req.params;
    const { thumbnail } = req.body;
    if (boards[id]) {
      boards[id].thumbnail = thumbnail;
      saveBoards();
      res.json({ success: true });
    } else {
      res.status(404).json({ error: "Board not found" });
    }
  });

  // WebSocket logic
  const clients = new Map<WebSocket, { boardId: string; userId: string; name: string }>();

  wss.on("connection", (ws) => {
    ws.on("message", (data) => {
      try {
        const msg: Message = JSON.parse(data.toString());
        
        if (msg.type === 'join') {
          clients.set(ws, { boardId: msg.boardId, userId: uuidv4(), name: msg.payload.name });
          
          // Send board data
          const board = boards[msg.boardId];
          if (board) {
            ws.send(JSON.stringify({
              type: 'init',
              boardId: msg.boardId,
              payload: board
            }));
          }
          return;
        }

        const clientInfo = clients.get(ws);
        if (!clientInfo || clientInfo.boardId !== msg.boardId) return;

        if (msg.type === 'draw') {
          const board = boards[msg.boardId];
          if (board && board.pages[msg.payload.pageIndex]) {
            board.pages[msg.payload.pageIndex].elements.push(msg.payload.element);
            saveBoards();
            broadcast(msg, ws);
          }
        } else if (msg.type === 'clear') {
           const board = boards[msg.boardId];
           if (board && board.pages[msg.payload.pageIndex]) {
             board.pages[msg.payload.pageIndex].elements = [];
             saveBoards();
             broadcast(msg, ws);
           }
        } else if (msg.type === 'add_page') {
           const board = boards[msg.boardId];
           if (board) {
             board.pages.push({ id: uuidv4(), elements: [] });
             saveBoards();
             broadcast(msg, ws);
           }
        } else if (msg.type === 'delete_page') {
           const board = boards[msg.boardId];
           if (board && board.pages.length > 1) {
             board.pages.splice(msg.payload.pageIndex, 1);
             saveBoards();
             broadcast(msg, ws);
           }
        }
      } catch (err) {
        console.error("WS Error:", err);
      }
    });

    ws.on("close", () => {
      clients.delete(ws);
    });
  });

  function broadcast(msg: Message, skipWs?: WebSocket) {
    const json = JSON.stringify(msg);
    wss.clients.forEach((client) => {
      if (client !== skipWs && client.readyState === WebSocket.OPEN) {
        const info = clients.get(client);
        if (info && info.boardId === msg.boardId) {
          client.send(json);
        }
      }
    });
  }

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
