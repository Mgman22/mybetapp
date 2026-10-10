V27: Favored/price team alignment fix

- Bettor match card now colors the configured body_favored_side red, regardless of actual football home/away position.
- The other team remains blue.
- Body settlement calculation now uses the favored team as the reference side, including when the favored team is the actual away team.
- New body bets store body_favored_side snapshot on the bet row. Existing bets fall back to the match setting for backward compatibility.
- Bet modal colors the selected favored body team red.
- Kickoff expiry rendering uses the server-synchronized clock.
