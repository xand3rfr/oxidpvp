// Draw & Guess words: common nouns that are fun to draw.
window.DRAW_WORDS = (
  "apple banana pizza burger hotdog donut cookie cake cupcake icecream sandwich taco sushi popcorn cheese egg bread carrot " +
  "pumpkin watermelon cherry grapes lemon pineapple strawberry broccoli mushroom corn coffee teapot " +
  "cat dog fish shark whale dolphin octopus crab snail spider bee butterfly ladybug snake turtle frog rabbit mouse horse " +
  "cow pig sheep chicken duck owl penguin eagle parrot giraffe elephant lion tiger zebra monkey bear panda kangaroo camel " +
  "dinosaur dragon unicorn ghost robot alien vampire zombie wizard pirate ninja knight princess mermaid clown astronaut " +
  "house castle igloo tent lighthouse bridge tower pyramid windmill barn church school hospital skyscraper " +
  "car bus train plane helicopter rocket boat submarine bicycle skateboard tractor truck ambulance motorcycle sailboat " +
  "sun moon star cloud rainbow lightning tornado volcano mountain island beach river waterfall desert cactus tree flower " +
  "rose leaf mushroom snowman snowflake fire campfire iceberg cave forest " +
  "guitar piano drum trumpet violin microphone headphones radio television camera phone laptop keyboard computer " +
  "clock watch lamp candle key lock door window ladder chair table bed sofa bathtub toilet mirror umbrella " +
  "hat crown glasses shoe boot sock shirt dress scarf glove backpack wallet ring necklace " +
  "ball football basketball baseball tennis bowling trophy medal kite balloon yoyo puzzle dice chess cards " +
  "book pencil scissors paintbrush crayon envelope newspaper map globe magnet battery lightbulb rocket telescope " +
  "hammer saw shovel axe sword shield bow arrow cannon anchor compass hourglass treasure bomb " +
  "heart skeleton skull brain eye nose ear mouth hand foot tooth beard mustache " +
  "spaceship planet satellite comet " +
  "fireworks birthday present snowball sandcastle swing slide trampoline rollercoaster wheel " +
  "toothbrush toothpaste soap bubble sponge bucket broom vacuum fridge oven toaster blender microwave " +
  "mailbox fence garden scarecrow spiderweb nest egg honey beehive worm ant " +
  "jellyfish seahorse starfish lobster squid flamingo peacock swan bat wolf fox deer hedgehog squirrel koala sloth"
).split(/\s+/).filter((w, i, a) => w && a.indexOf(w) === i);
