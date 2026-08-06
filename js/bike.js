function getBikeProfile(){

    const profile =
    document.getElementById("bikeProfile").value;


    if(profile==="city"){

        return {

            safety:0.5,
            speed:0.2,
            wind:0.3

        };

    }


    if(profile==="road"){

        return {

            safety:0.2,
            speed:0.5,
            wind:0.3

        };

    }


    if(profile==="touring"){

        return {

            safety:0.6,
            speed:0.1,
            wind:0.3

        };

    }

}
