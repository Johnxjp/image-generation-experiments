# Interaction Modes for Creative Exploration
https://johnxjp.github.io/writing.html#creative-exploration

Ideas often begin as faint sensations: a single image, a thought, a desire to express a feeling. Miyazaki says “you can start with a vague yearning…a certain sentiment, a slight sliver of emotion — whatever it is”. Following that, the real work begins to give shape to the idea and that often starts with unfettered exploration. Our tools shouldn’t stand in the way of this; they should allow us to frictionlessly explore the creative space at the speed of imagination — to rapidly generate, edit, tweak, curate, remix, cut, layer and whatever else is needed to drag an idea from dreamland into the real world. 

Today we’re building the dream machines — media generation models — that allow us to project our ideas onto pixels. And they are rapidly improving and becoming widely adopted across industries. But while this is the case, it still feels that we’re missing interaction modes to help us fully unlock their power. Rather, it feels like we’re missing tools that are aligned with how the creative mind wants to work. If you look around at most companies providing visual content generation, their interfaces are still often linear and centred primarily on text prompting. There’s a lot of friction and it’s not simply because generation is still high latency. There are few options that help the user actually explore new and interesting territory in the search space whether that’s through intentional adjustments e.g. edits, or serendipitously e.g. via associative search. What if we could instead design tools to be great collaborators thereby better able to support creative exploration? 

Below are my explorations of that question concentrating on generating variations along a conceptual dimension.

## Concept 1: Dimensions
My starting point was dimensions of change. Inspired by Bryan Loh’s post on creative exploration and latent spaces, I envisioned allowing the user to create variations of an initial image along a specific dimension. The intent here was to allow the user to quickly visualise alternatives that might inspire new creative avenues. 

For example, a user could explore colour variations or even concepts like “temperature”. Other examples could be “age”, “sweetness” or perhaps even more abstract dimensions like “democracy” (Of course, they don’t have to be single words). Here’s an example.

![image](/assets/generate.gif)

As I started to poke at this thought, it became immediately clear though that not all concepts could be easily specified by a continuous scale e.g. “mode of transportation”. On top of that, I realised there’s so much room for ambiguity. Changes like “mode of transportation” might be seemingly obvious but what about “temperature”? Does the user mean hotter or colder? What does a “democracy” scale even look like? It’s clearly difficult to design something that works well and so without shame, and for the sake of these early explorations I actually deferred this judgement to an LLM.

I prompted an LLM to generate N variants based on the description of the initial image and the user’s specified dimension of change. The LLM is instructed to match the initial description changing only the aspects related to the user’s suggested change and to attempt to form a natural progression. One benefit of using LLMs is that there is always the possibility of surprise, which is an advantage for creative work.

Below is an example of an attempt to make the original image ‘more dramatic’. What I had in mind was something closer to the third variant in this chain i.e. applying warmer colours, so the LLM surprised me with the final night scene. 

![image](/assets/dramatic.png)

##  Concept 2: Spatial Distance
I decided on a canvas UI to amplify the feeling of unfettered exploration. I wondered though how we could represent the number of steps along a dimension. It seemed natural to use distance from the origin to represent this so the further the user pulls from the original image the more intermediate nodes will be generated. The number of generations is shown by dots on the line.

![image](/assets/spatial.gif)

## Concept 3: Parallel Application
It felt quite natural to then take this idea of graded variations and want to apply that to multiple base images simultaneously. In practice, you can imagine wanting to apply a ‘style’ to multiple inputs. 

![image](/assets/parallel.gif)

I have to admit that the above example came out too well as each base image was prompted independently. 

## Concept 4: Interpolation
The last idea I wanted to test was automatic interpolation between two images i.e. allowing the system to define a dimension of change based on the inputs and then generating intermediate images. 

I initially tackled this using image-to-image video generation model and extracting intermediate frames. The challenge here was choosing which frames to extract so that the visual isn’t an awkward transition moment as in the case below.

![image](/assets/video_interpolation.gif)

I didn’t solve that problem directly and instead decided to switch back to image generation prompting the LLM to take the scene descriptions from the start and end nodes, identifying a dimension of change, categorising as continuous or discrete, and then generating suitable image prompts following that. Below were the results from that experiment.

![image](/assets/image_to_image_interpolation.gif)

The results are far from usable and I didn’t spend long on fine-tuning my prompt. So hopefully, with more time experimenting something more reasonable could be attainable! 

## End
Looking back at these experiments, the thing I keep returning to is the ambiguity problem I brushed past. "Warmer" has a direction. "Democracy" not so much, and neither does "mode of transportation". In these experiments, I deferred the interpretation to an LLM and let it pick a reading. It works but hides that a word like this is a signal that several distinct axes are hiding inside one term. Democracy as crowds, as bureaucracy, as ritual. The more interesting idea is to show those readings rather than silently collapse them e.g. fan the ambiguous concept into a handful of candidate dimensions, each with its own scale, and let the user discover which one they meant by travelling down it. Unambiguous dimensions get a clean slider whereas ambiguous ones could branch. 

The degree of ambiguity then becomes a control signal for the interface rather than a nuisance to be resolved. It also suggests where surprise belongs in these tools. Surprise is welcome when it comes from a concept being genuinely underdetermined, because the tool is showing you something that was already latent in what you asked for. It's much less welcome when it's randomness injected into a request that was perfectly clear, which just reads as the tool not listening.

[All the code for this experiment was created with Claude and is available on my [GitHub](https://github.com/Johnxjp/image-generation-experiments/tree/main). I used FAL for access to generation models API and Gemini models for the LLM. If you’re working with generative media tools and interfaces, feel free to reach out. Would love to hear your ideas.]
