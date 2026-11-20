# voiceLeveler

makes everyone in voice about the same volume

![voiceLeveler](https://raw.githubusercontent.com/naystie/images/main/voiceLeveler/banner.png)

## features

- turns quiet people up and loud people down
- the button next to noise suppression in the voice panel shows everyone in the call and what auto level did to them. the **voice level** slider, **shout limit** and **crowd mode** are in there too
- **focus** on someone and everyone else gets quieter while they talk
- **shout limit** turns people down right away when they shout
- **crowd mode** turns everyone down a little when lots of people talk at once
- background noise and mics that never turn off are kept down, never turned up
- notices when someone switches mics or changes their input volume and relearns them
- a bad connection won't make auto level think someone is quiet
- **auto level** and **focus** below every user's volume slider when you right click them
- leaves bots and people you muted alone. manually moving a user's volume slider stops auto-leveling for them until you leave or switch channels

## how it works

- discord's voice engine already knows how loud every user's voice is. the plugin uses this information four times per second
- changes are temporary. your user volume settings are never touched
- it goes by how loud someone is over their last minute of talking, so a few quiet words or one loud laugh won't change anything

## settings

**voice level** controls how loud everyone ends up and is usually the only setting anyone needs to change. it's in the voice panel too

| setting | default | |
| --- | --- | --- |
| voice level | 100% | how loud everyone ends up, 10% to 200% |
| lowest volume | 50% | never turns anyone down below this |
| highest volume | 200% | never turns anyone up above this |
| shout limit | on | turns people down right away when they shout |
| crowd mode | off | turns everyone down a little while lots of people talk |
| level custom volumes | on | also levels people you set your own volume for |
| ignore bots | on | for music bots |
| voice panel button | on | shows the auto level button in the voice panel |
| remember for | 30 days | how long it remembers each person |
| reset auto level | | forgets everyone and starts over |

## heads up

- needs 8 to 20 seconds of someone talking before changing them. after that it remembers them and fixes them right away next time they join
- it works only on the desktop app

## install

if you made it here you probably already know how to install custom plugins, but if not just check [vencord's guide](https://docs.vencord.dev/installing/custom-plugins/)
