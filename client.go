package main

import (
	"bufio"
	"flag"
	"fmt"
	"log"
	"net/url"
	"os"
	"strconv"
	"strings"

	"github.com/gorilla/websocket"
)

// ANSI Colors
const (
	ColorReset  = "\033[0m"
	ColorRed    = "\033[31m"
	ColorGreen  = "\033[32m"
	ColorYellow = "\033[33m"
	ColorCyan   = "\033[36m"
)

type Message struct {
	Type     string `json:"type"`
	Username string `json:"username"`
	Amount   int    `json:"amount"`
	Content  string `json:"content"`
	TimeLeft int    `json:"time_left"`
}

var currentPrice int
var highBidder string
var timeLeft int
var feedback string // Status message (e.g., "Bid too low")

func main() {
	username := flag.String("u", "Bidder", "Your Username")
	server := flag.String("s", "localhost:8080", "Server Address")
	flag.Parse()

	u := url.URL{Scheme: "ws", Host: *server, Path: "/ws"}

	c, _, err := websocket.DefaultDialer.Dial(u.String(), nil)
	if err != nil {
		log.Fatal("Connection error:", err)
	}
	defer c.Close()

	// Screen Refresher & Listener
	go func() {
		for {
			var msg Message
			err := c.ReadJSON(&msg)
			if err != nil {
				log.Println("Server lost.")
				os.Exit(0)
			}

			if msg.Type == "update" {
				currentPrice = msg.Amount
				highBidder = msg.Username
				timeLeft = msg.TimeLeft
				if msg.Content != "" {
					feedback = msg.Content
				}
			} else if msg.Type == "error" {
				feedback = ColorRed + msg.Content + ColorReset
			} else if msg.Type == "end" {
				currentPrice = msg.Amount
				highBidder = msg.Username
				timeLeft = 0
				feedback = ColorYellow + msg.Content + ColorReset
				drawDashboard(*username)
				os.Exit(0)
			}
			drawDashboard(*username)
		}
	}()

	// Input Loop
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		text := strings.TrimSpace(scanner.Text())
		amount, err := strconv.Atoi(text)
		if err != nil {
			continue // Ignore non-numbers
		}

		// Send Bid
		msg := Message{
			Type:     "bid",
			Username: *username,
			Amount:   amount,
		}
		c.WriteJSON(msg)
	}
}

func drawDashboard(user string) {
	// Clear screen (ANSI)
	fmt.Print("\033[H\033[2J")

	// Header
	fmt.Println("========================================")
	fmt.Printf("   🔨 HIGH SPEED AUCTION: RARE GPU    \n")
	fmt.Println("========================================")

	// Timer logic to make it look urgent
	timeColor := ColorGreen
	if timeLeft < 10 {
		timeColor = ColorRed
	}
	fmt.Printf("TIME REMAINING: %s%ds%s\n\n", timeColor, timeLeft, ColorReset)

	// Price Block
	fmt.Printf("CURRENT PRICE:  %s$%d%s\n", ColorGreen, currentPrice, ColorReset)

	if highBidder == user {
		fmt.Printf("HIGH BIDDER:    %sYOU%s\n", ColorGreen, ColorReset)
	} else {
		fmt.Printf("HIGH BIDDER:    %s%s%s\n", ColorCyan, highBidder, ColorReset)
	}

	fmt.Println("\n----------------------------------------")
	fmt.Printf("STATUS: %s\n", feedback)
	fmt.Println("----------------------------------------")
	fmt.Print("Enter Bid Amount > ")
}
