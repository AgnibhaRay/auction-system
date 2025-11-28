package main

import (
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// --- STATE ---
type AuctionState struct {
	ItemName     string
	CurrentPrice int
	HighBidder   string
	TimeLeft     int
	Running      bool
	mu           sync.Mutex
}

var auction = AuctionState{
	ItemName:     "Waiting for Admin...",
	CurrentPrice: 0,
	HighBidder:   "None",
	TimeLeft:     0,
	Running:      false,
}

var upgrader = websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return true }}
var clients = make(map[*websocket.Conn]bool)
var broadcast = make(chan Message)

type Message struct {
	Type     string `json:"type"` // update, bid, start, end
	Username string `json:"username"`
	Amount   int    `json:"amount"`
	ItemName string `json:"item_name"` // New field
	Content  string `json:"content"`
	TimeLeft int    `json:"time_left"`
}

func main() {
	// 1. Start Timer Routine
	go runTimer()
	// 2. Start Broadcaster Routine
	go handleMessages()

	// // 3. Serve Static HTML Files (The GUI)
	// fs := http.FileServer(http.Dir("./static"))
	// http.Handle("/", fs)

	// 4. WebSocket Endpoint
	http.HandleFunc("/ws", handleConnections)

	log.Println("🌐 GUI Server started on http://localhost:8080")
	log.Println("👉 Admin Panel: http://localhost:8080/admin.html")
	log.Fatal(http.ListenAndServe(":8080", nil))
}

func runTimer() {
	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		auction.mu.Lock()
		if auction.Running && auction.TimeLeft > 0 {
			auction.TimeLeft--
			broadcastState()
		} else if auction.Running && auction.TimeLeft == 0 {
			auction.Running = false
			broadcast <- Message{Type: "end", Content: "AUCTION ENDED!", ItemName: auction.ItemName, Amount: auction.CurrentPrice, Username: auction.HighBidder}
		}
		auction.mu.Unlock()
	}
}

func handleConnections(w http.ResponseWriter, r *http.Request) {
	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer ws.Close()
	clients[ws] = true

	// Send current state on connect
	auction.mu.Lock()
	ws.WriteJSON(Message{
		Type: "update", ItemName: auction.ItemName, Amount: auction.CurrentPrice,
		Username: auction.HighBidder, TimeLeft: auction.TimeLeft,
	})
	auction.mu.Unlock()

	for {
		var msg Message
		err := ws.ReadJSON(&msg)
		if err != nil {
			delete(clients, ws)
			break
		}

		if msg.Type == "bid" {
			processBid(ws, msg)
		} else if msg.Type == "start" {
			startAuction(msg)
		}
	}
}

func startAuction(msg Message) {
	auction.mu.Lock()
	auction.ItemName = msg.ItemName
	auction.CurrentPrice = msg.Amount
	auction.TimeLeft = 60 // Fixed duration for simplicity
	auction.HighBidder = "House"
	auction.Running = true
	auction.mu.Unlock()

	broadcastState()
}

func processBid(ws *websocket.Conn, msg Message) {
	auction.mu.Lock()
	defer auction.mu.Unlock()

	if !auction.Running {
		return
	}

	if msg.Amount > auction.CurrentPrice {
		auction.CurrentPrice = msg.Amount
		auction.HighBidder = msg.Username
		// Add 10 seconds if bid comes in late (Sniping prevention)
		if auction.TimeLeft < 10 {
			auction.TimeLeft += 10
		}
		broadcastState()
	}
}

func broadcastState() {
	// Helper to send current state to channel
	// Note: Caller must hold Lock, or we copy values carefully.
	// Here we are already inside a Lock usually, but for ticker we need to be careful.
	// For simplicity in this MVP, we construct message based on current auction state.
	msg := Message{
		Type: "update", ItemName: auction.ItemName, Amount: auction.CurrentPrice,
		Username: auction.HighBidder, TimeLeft: auction.TimeLeft,
	}
	// Non-blocking send to broadcast channel
	select {
	case broadcast <- msg:
	default:
	}
}

func handleMessages() {
	for {
		msg := <-broadcast
		for client := range clients {
			client.WriteJSON(msg)
		}
	}
}
