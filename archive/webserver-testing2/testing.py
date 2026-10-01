import requests
import json

# Define the Scryfall API URL
SCRYFALL_API_URL = "https://api.scryfall.com/cards/search"

# Fetch cards based on the search query (Creatures only)
def fetch_creature_subtypes():
    subtypes = set()  # Use a set to ensure uniqueness
    page = 1  # Start with the first page

    while True:
        print(f"Fetching page {page}...")
        
        # Send request to Scryfall API for creatures
        response = requests.get(SCRYFALL_API_URL, params={
            "q": "type:creature",
            "page": page
        })
        
        # Check if the request was successful
        if response.status_code != 200:
            print("Error fetching data from Scryfall API")
            break
        
        # Get the data from the response
        data = response.json()

        # Loop through the cards and extract creature subtypes
        for card in data['data']:
            type_line = card.get('type_line', '')
            
            # If the card is a creature, extract subtypes from the type_line
            if 'Creature' in type_line:
                # Split the type line and check for subtypes
                types = type_line.split(' ')
                creature_subtypes = [t for t in types if t not in ["Creature", "Legendary"]]
                
                # Add each subtype to the set
                subtypes.update(creature_subtypes)

        # If there are more pages, go to the next page
        if 'next_page' in data:
            page = data['next_page']
        else:
            break

    print(f"Found {len(subtypes)} unique creature subtypes.")
    return sorted(list(subtypes))  # Return as a sorted list

# Save the creature subtypes to a file
def save_creature_subtypes(subtypes):
    with open('creature_subtypes.json', 'w') as f:
        json.dump(subtypes, f, indent=2)

if __name__ == "__main__":
    subtypes = fetch_creature_subtypes()
    save_creature_subtypes(subtypes)
