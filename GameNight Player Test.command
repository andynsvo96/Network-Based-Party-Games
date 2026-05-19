#!/bin/bash
URL="http://192.168.1.192:3000/players"

# Chrome - new window
if [ -d "/Applications/Google Chrome.app" ]; then
    open -na "Google Chrome" --args --new-window "$URL"
fi

# Firefox - new window
if [ -d "/Applications/Firefox.app" ]; then
    open -na "Firefox" --args -new-window "$URL"
fi

# Edge - new window
if [ -d "/Applications/Microsoft Edge.app" ]; then
    open -na "Microsoft Edge" --args --new-window "$URL"
fi

# Opera - new window
if [ -d "/Applications/Opera.app" ]; then
    open -na "Opera" --args --new-window "$URL"
fi
