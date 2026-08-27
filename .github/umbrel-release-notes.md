<!-- version: 2.45.0 -->
The Pantry now speaks up before something reaches its best-before date. It has stored those dates since the module arrived, and it has coloured the row yellow when one came close - but it never told anyone. That only helps the jar you happen to look at, and the one at the back of the shelf is exactly the one you don't. A week before a date is reached, the item now sends a notification, through the same channels as every other reminder.

The date itself is the switch. Salt, rice and tinned food carry no best-before date and stay silent; anything you did give one to will announce itself. There is no new setting and nothing per item to fill in - the lead time is the same week that already turns the row yellow in the list, so the notification arrives on the day you see the item change colour.

Fresh food is the case this was built for, and it needed care: milk and yoghurt usually have fewer than seven days left when you carry them home, so their week is already gone at the moment you enter them. Rather than staying quiet, those land on the next morning's notification. An item that has already passed its date does not notify at all - by then the list says so plainly, and a warning after the fact is not a warning.

**What happens right after the update:** your existing stock is picked up automatically. Items that were on the shelf before this version were never saved through the app since it arrived, so nothing would ever have reminded you about them; the first notification run after the update catches them up. Expect a quiet morning rather than a burst - anything whose week has already passed is left alone, precisely so that an update does not greet you with thirty messages.

An empty pack does not notify. If you have booked the last of something out, there is nothing left to save, and buying it again brings the reminder back on its own.

This release also closes a gap in how reminders are handed out to integrations: an API token limited to the calendar could read the name of a subscription or an inventory item through a due reminder, and the same applied to a household member whose access to those modules had been withdrawn. Reminders are now filtered by the module they come from. If you use an API token to read reminders, it needs the scope of the module in question from now on.

Nothing needs configuring and there is nothing to do after the update - the database change is applied automatically on first start. Notifications reach you wherever you have already set them up, under Settings.

Full release notes are available at https://github.com/ulsklyc/yuvomi/releases/tag/v2.45.0
